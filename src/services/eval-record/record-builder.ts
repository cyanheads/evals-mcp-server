/**
 * @fileoverview Shared eval-record assembly and presentation helpers used by the
 * authoring tools: build a normalized draft from `evals_create_draft` input
 * (server stamps id, created_at, content_hash, default license), enforce the
 * cross-field constraints the discriminated union can't express (mcq.correct ∈
 * choices; free_response ⇒ llm_rubric grader), detect recorded verification, and
 * render the parrot-back review protocol + ready-to-paste subagent prompt that
 * make `evals_create_draft` a reflection forcing function.
 * @module services/eval-record/record-builder
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { EvalRecord, Grader, TaskType } from '@/services/eval-record/schema.js';
import { gradeCandidate, type SelfConsistency } from '@/services/grader/grader-service.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

/**
 * The optional draft-time verification block a caller may seed on create.
 * Optionals carry `| undefined` to stay compatible with the Zod-inferred tool
 * input under `exactOptionalPropertyTypes`.
 */
export interface VerificationInput {
  evidence?: EvalRecord['verification']['evidence'] | undefined;
  generation_method?: string | undefined;
  method: string;
}

/** The shape `evals_create_draft` accepts (flat — server wraps provenance/created_at). */
export interface CreateDraftInput {
  author_model?: string | undefined;
  captures?: string[] | undefined;
  choices?: string[] | undefined;
  context?: string | undefined;
  discrimination: { positive: unknown[]; negative: unknown[] };
  gold: unknown;
  grader: Grader;
  metadata: {
    domain: string;
    tags: string[];
    license?: string | undefined;
    source_provenance?: EvalRecord['metadata']['source_provenance'] | undefined;
    contamination_notes?: string | undefined;
  };
  prompt: string;
  task_type: TaskType;
  verification?: VerificationInput | undefined;
}

/**
 * Enforce the per-task-type cross-field rules that live outside the Zod union:
 * mcq needs choices and the grader's `correct` must be one of them; free_response
 * needs an `llm_rubric` grader. Throws `validationError` otherwise.
 */
export function assertTaskTypeConstraints(
  record: Pick<EvalRecord, 'task_type' | 'grader' | 'choices'>,
): void {
  if (record.task_type === 'mcq') {
    if (!record.choices || record.choices.length === 0) {
      throw validationError('mcq records require a non-empty choices[] array.', {
        reason: 'task_type_constraint',
        task_type: 'mcq',
      });
    }
    if (record.grader.kind === 'mcq' && !record.choices.includes(record.grader.correct)) {
      throw validationError(
        `mcq grader correct answer "${record.grader.correct}" must equal one element of choices[]: ${record.choices.join(', ')}.`,
        {
          reason: 'task_type_constraint',
          task_type: 'mcq',
        },
      );
    }
  }
  if (record.task_type === 'free_response' && record.grader.kind !== 'llm_rubric') {
    throw validationError('free_response records require a grader of kind "llm_rubric".', {
      reason: 'task_type_constraint',
      task_type: 'free_response',
    });
  }
}

/**
 * Assemble a normalized `draft` record from create input, stamping the
 * server-owned fields (id, created_at, content_hash) and applying the default
 * license. Validates the task-type constraints before returning.
 */
export function buildDraft(
  input: CreateDraftInput,
  defaultLicense: string | undefined,
): EvalRecord {
  const store = getRecordStoreService();
  const id = store.newId();

  const license = input.metadata.license ?? defaultLicense;
  const draft: EvalRecord = {
    id,
    status: 'draft',
    task_type: input.task_type,
    prompt: input.prompt,
    ...(input.context !== undefined ? { context: input.context } : {}),
    gold: input.gold,
    grader: input.grader,
    discrimination: {
      positive: input.discrimination.positive,
      negative: input.discrimination.negative,
    },
    ...(input.choices !== undefined ? { choices: input.choices } : {}),
    metadata: {
      domain: input.metadata.domain,
      tags: input.metadata.tags,
      ...(license !== undefined ? { license } : {}),
      ...(input.metadata.source_provenance !== undefined
        ? { source_provenance: input.metadata.source_provenance }
        : {}),
      ...(input.metadata.contamination_notes !== undefined
        ? { contamination_notes: input.metadata.contamination_notes }
        : {}),
    },
    verification: {
      method: input.verification?.method ?? 'unspecified',
      ...(input.verification?.generation_method !== undefined
        ? { generation_method: input.verification.generation_method }
        : {}),
      evidence: input.verification?.evidence ?? [],
    },
    ...(input.captures !== undefined ? { captures: input.captures } : {}),
    provenance: {
      author_model: input.author_model ?? 'unknown',
      created_at: new Date().toISOString(),
    },
    content_hash: '',
  } as EvalRecord;

  assertTaskTypeConstraints(draft);
  draft.content_hash = store.computeContentHash(draft);
  return draft;
}

/** True when the record carries at least one verification evidence entry. */
export function hasRecordedVerification(record: EvalRecord): boolean {
  return record.verification.evidence.length > 0;
}

/** Render a gold value compactly for the parrot-back (with the numeric resolution when known). */
function renderGold(record: EvalRecord, resolved: unknown): string {
  const gold = typeof record.gold === 'object' ? JSON.stringify(record.gold) : String(record.gold);
  if (
    record.task_type === 'numeric' &&
    typeof resolved === 'number' &&
    String(record.gold) !== String(resolved)
  ) {
    return `${gold}  →  ${resolved}`;
  }
  return gold;
}

/** Render a grader spec compactly for the parrot-back. */
function renderGrader(grader: Grader, resolved: unknown): string {
  switch (grader.kind) {
    case 'numeric': {
      const tol =
        grader.rel_tol !== undefined
          ? `rel_tol=${grader.rel_tol}`
          : grader.abs_tol !== undefined
            ? `abs_tol=${grader.abs_tol}`
            : 'rel_tol=1e-9';
      const tgt =
        typeof resolved === 'number' && String(grader.target) !== String(resolved)
          ? `${grader.target} (=${resolved})`
          : String(grader.target);
      return `numeric, target=${tgt}, ${tol}`;
    }
    case 'exact_match':
      return `exact_match${grader.normalize?.length ? `, normalize=[${grader.normalize.join(', ')}]` : ''}`;
    case 'set_match':
      return `set_match, expected={${grader.expected.join(', ')}}${grader.order_sensitive ? ', ordered' : ''}`;
    case 'regex':
      return `regex, /${grader.pattern}/${grader.flags ?? ''}`;
    case 'mcq':
      return `mcq, correct=${grader.correct}`;
    case 'json_match':
      return `json_match${grader.expected !== undefined ? ', expected' : ''}${grader.schema !== undefined ? ', schema' : ''}`;
    case 'llm_rubric':
      return `llm_rubric, ${grader.criteria.length} criteria, pass_threshold=${grader.pass_threshold}`;
  }
}

/**
 * Build the `format()` markdown: parrot the record back behind a divider, then
 * the review protocol and the ready-to-paste subagent prompt. The same content
 * the structured fields carry, on the content[] surface.
 */
export function renderDraftReview(
  record: EvalRecord,
  checks: SelfConsistency,
  reviewProtocol: string,
  subagentPrompt: string,
  requiredBeforeSubmit: string[],
): string {
  // Total over any value of the output schema: a record without a grader (e.g. a
  // linter's synthetic sample) renders a minimal stub rather than throwing.
  if (!record?.grader?.kind) {
    return `Draft saved: ${record?.id ?? '(unknown)'}   (status: ${record?.status ?? 'draft'})\n\n${reviewProtocol}\n\n${subagentPrompt}\n\n${requiredBeforeSubmit.join('\n')}`;
  }
  // Resolve the gold's comparison reference for the parrot-back (numeric only; cheap, deterministic).
  const goldResolved =
    record.grader.kind === 'llm_rubric'
      ? undefined
      : gradeCandidate(record.grader, record.gold, record.gold, record.choices).resolved;
  const lines: string[] = [];
  lines.push(`Draft saved: ${record.id}   (status: ${record.status})`, '');
  lines.push('──────────────────────  REVIEW BEFORE SUBMIT  ──────────────────────');
  lines.push(`task_type:  ${record.task_type}`);
  lines.push(`prompt:     ${JSON.stringify(record.prompt)}`);
  if (record.context) lines.push(`context:    ${JSON.stringify(record.context)}`);
  lines.push(`gold:       ${renderGold(record, goldResolved)}`);
  lines.push(`grader:     ${renderGrader(record.grader, goldResolved)}`);
  if (record.choices) lines.push(`choices:    ${record.choices.join(' | ')}`);
  lines.push(
    `positives:  ${record.discrimination.positive.map((p) => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join(', ') || '(none)'}`,
  );
  const negStatus = checks.negatives_rejected;
  lines.push(
    `negative:   ${record.discrimination.negative.map((n, i) => `${typeof n === 'object' ? JSON.stringify(n) : String(n)}${negStatus[i] ? ' (rejected ✓)' : ' (NOT rejected ✗)'}`).join(', ') || '(none — required before submit)'}`,
  );
  lines.push(`domain:     ${record.metadata.domain}`);
  lines.push('─────────────────────────────────────────────────────────────────────', '');
  lines.push(reviewProtocol, '');
  lines.push('RECOMMENDED — independent verification via a subagent:');
  lines.push('Spawn a subagent (Sonnet-tier is sufficient), connected to this server, with the');
  lines.push('prompt below. It reviews the draft and reports back; then apply surgical fixes with');
  lines.push('evals_revise_draft and finalize with evals_submit_draft.', '');
  lines.push('  ┌─ subagent prompt ─────────────────────────────────────────────────┐');
  for (const line of subagentPrompt.split('\n')) lines.push(`  │ ${line}`);
  lines.push('  └────────────────────────────────────────────────────────────────────┘', '');
  lines.push('Still required before submit:');
  for (const item of requiredBeforeSubmit) lines.push(`• ${item}`);
  return lines.join('\n');
}

/** The static per-field review protocol text. */
export const REVIEW_PROTOCOL =
  'Work through each line above. For every field ask: is it accurate, unambiguous, and complete? Verify anything checkable against live or authoritative sources — do not trust memory.';

/** Build the ready-to-paste subagent verification prompt for a specific draft id. */
export function buildSubagentPrompt(id: string): string {
  return [
    `Verify draft eval record ${id}. Call evals_get_record with id "${id}".`,
    'For each field check accuracy (verify claims against live sources), ambiguity, and gaps.',
    'Independently re-derive or look up the gold (use evals_run_check to re-derive deterministically).',
    'Report CONCISELY: one bullet per issue (field, problem, suggested fix), or "no issues".',
    'Do NOT modify the record — the authoring agent will apply surgical updates.',
  ].join('\n');
}

/** Build the `required_before_submit` checklist from the current self-consistency state. */
export function buildRequiredBeforeSubmit(checks: SelfConsistency, record: EvalRecord): string[] {
  const items: string[] = [];
  if (!checks.verification_present) {
    items.push(
      'An independent verification recorded on the record (the subagent report, or your own decorrelated check) — append it to verification.evidence.',
    );
  }
  if (record.discrimination.negative.length === 0) {
    items.push(
      'At least one negative case in discrimination.negative that the grader correctly rejects.',
    );
  }
  if (!checks.gold_passes_grader && record.grader.kind !== 'llm_rubric') {
    items.push('Fix the gold or grader — the gold does not currently pass its own grader.');
  }
  if (items.length === 0)
    items.push(
      'Ready: grader is self-consistent and a verification is recorded. Run evals_submit_draft to finalize.',
    );
  return items;
}
