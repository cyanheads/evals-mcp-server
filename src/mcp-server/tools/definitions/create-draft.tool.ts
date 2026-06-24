/**
 * @fileoverview evals_create_draft — create a draft eval record. Validates against
 * the task_type union, persists it as a draft, runs the cheap self-consistency
 * check (grader vs gold + each positive must PASS, vs each negative must REJECT),
 * and returns the parsed record parroted back behind a divider, a per-field review
 * protocol, a ready-to-paste verification subagent prompt, and the self-consistency
 * result. The record stays draft — passing self-consistency proves the grader
 * discriminates, not that the gold is right.
 * @module mcp-server/tools/definitions/create-draft.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  buildDraft,
  buildRequiredBeforeSubmit,
  buildSubagentPrompt,
  hasRecordedVerification,
  REVIEW_PROTOCOL,
  renderDraftReview,
} from '@/services/eval-record/record-builder.js';
import {
  type EvalRecord,
  GraderSchema,
  MetadataSchema,
  RecordPayloadSchema,
  SelfConsistencySchema,
  TaskTypeSchema,
  VerificationInputSchema,
} from '@/services/eval-record/schema.js';
import { checkSelfConsistency } from '@/services/grader/grader-service.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

export const createDraftTool = tool('evals_create_draft', {
  title: 'evals-mcp-server: create draft',
  description:
    'Create a draft eval record carrying its own executable grader. Persists it as a draft, then returns the parsed record parroted back behind a divider, a per-field review protocol, a ready-to-paste verification subagent prompt, and the self-consistency result. It stays draft — self-consistency passing proves the grader discriminates, not that the gold is right; record an independent verification (a subagent report or your own decorrelated check) before evals_submit_draft.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({
    task_type: TaskTypeSchema,
    prompt: z.string().min(1).describe('The task shown to the model under test.'),
    context: z.string().optional().describe('An optional grounding passage for the task.'),
    gold: z
      .unknown()
      .describe(
        'The reference answer; its shape depends on task_type (a number/expression for numeric, a string for exact_answer, etc.).',
      ),
    grader: GraderSchema,
    discrimination: z
      .object({
        positive: z
          .array(z.unknown())
          .describe('Answers that MUST pass the grader (gold is implicitly one).'),
        negative: z
          .array(z.unknown())
          .describe('Known-wrong answers that MUST fail; at least one is required to submit.'),
      })
      .describe(
        'The discrimination cases that prove the grader accepts right answers and rejects wrong ones.',
      ),
    choices: z
      .array(z.string())
      .optional()
      .describe('The answer choices; required for mcq (grader.correct must equal one element).'),
    metadata: MetadataSchema.describe(
      'Record metadata: domain (required), tags (required), and optional license/provenance/contamination notes.',
    ),
    verification: VerificationInputSchema.optional().describe(
      'Optional draft-time verification provenance, if you already have evidence (method + generation_method + evidence[]).',
    ),
    captures: z
      .array(z.string())
      .optional()
      .describe(
        'EvalsIDs linking the fleet tool calls behind the answer; resolved from EVALS_CAPTURE_DIR at submit.',
      ),
    author_model: z
      .string()
      .optional()
      .describe(
        'The authoring model id; stored under provenance.author_model (falls back to "unknown").',
      ),
  }),
  output: z.object({
    draft_id: z.string().describe('The assigned record id, stable across the lifecycle.'),
    status: z.literal('draft').describe('Always "draft" — creation never finalizes.'),
    normalized_record: RecordPayloadSchema.describe(
      'The record as the server parsed and stored it, with server-stamped id/created_at/content_hash.',
    ),
    server_checks: z
      .object({
        self_consistency: SelfConsistencySchema.describe('The cheap self-consistency verdict.'),
      })
      .describe('The cheap self-consistency result (not the submit gate).'),
    review_protocol: z
      .string()
      .describe('The per-field review protocol to work through before submit.'),
    suggested_subagent_prompt: z
      .string()
      .describe('A ready-to-paste prompt for a fresh verification subagent.'),
    required_before_submit: z
      .array(z.string())
      .describe('What still must be true before evals_submit_draft will accept the record.'),
  }),
  errors: [
    {
      reason: 'grader_unexecutable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The grader spec cannot run against the gold (malformed math.js target, invalid regex, missing json_match reference).',
      recovery:
        'Fix the named grader field — correct the expression, pattern, or supply expected/schema — then retry.',
    },
    {
      reason: 'task_type_constraint',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A per-task-type rule is violated (mcq without choices or a correct not in choices; free_response without an llm_rubric grader).',
      recovery:
        'Add the missing field — provide choices for mcq, or an llm_rubric grader for free_response — then retry.',
    },
    {
      reason: 'mcq_choice_mismatch',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The mcq grader correct answer is not one of the choices.',
      recovery: 'Set grader.correct to one of the choices, or fix the choices array, then retry.',
    },
  ],

  async handler(input, ctx) {
    const store = getRecordStoreService();
    const cfg = getServerConfig();

    // Step 1+2: build (validates task-type constraints), then persist.
    const record = buildDraft(input, cfg.defaultLicense);
    await store.writeDraft(record, ctx);

    // Step 3: cheap self-consistency.
    const verificationPresent = hasRecordedVerification(record);
    const checks = checkSelfConsistency(
      record.grader,
      record.gold,
      record.discrimination.positive,
      record.discrimination.negative,
      record.choices,
      verificationPresent,
    );

    // Step 4: the reflection forcing function.
    const subagentPrompt = buildSubagentPrompt(record.id);
    const requiredBeforeSubmit = buildRequiredBeforeSubmit(checks, record);

    ctx.log.info('Created draft', {
      id: record.id,
      task_type: record.task_type,
      grader_ok: checks.grader_ok,
    });

    return {
      draft_id: record.id,
      status: 'draft' as const,
      normalized_record: record,
      server_checks: { self_consistency: checks },
      review_protocol: REVIEW_PROTOCOL,
      suggested_subagent_prompt: subagentPrompt,
      required_before_submit: requiredBeforeSubmit,
    };
  },

  format: (result) => {
    const sc = result.server_checks.self_consistency;
    const head = [
      `draft_id: ${result.draft_id}  (status: ${result.status})`,
      `self-consistency: gold_passes_grader=${sc.gold_passes_grader}, grader_ok=${sc.grader_ok}, verification_present=${sc.verification_present}, ready_to_submit=${sc.ready_to_submit}`,
      `positives_pass: [${sc.positives_pass.join(', ')}]  ·  negatives_rejected: [${sc.negatives_rejected.join(', ')}]`,
      '',
    ].join('\n');
    const review = renderDraftReview(
      result.normalized_record as EvalRecord,
      sc,
      result.review_protocol,
      result.suggested_subagent_prompt,
      result.required_before_submit,
    );
    return [{ type: 'text', text: head + review }];
  },
});
