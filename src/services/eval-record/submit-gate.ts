/**
 * @fileoverview The submit gate — the committability invariant enforced
 * mechanically at evals_submit_draft. Runs the grader against gold (must PASS)
 * and each negative (≥1, must REJECT), asserts a recorded independent
 * verification exists and agrees with gold, enforces decorrelation (the
 * verification path must differ from the generation path), resolves and embeds
 * capture dumps, and checks content_hash dedup. Returns a typed failure (which
 * the tool maps to ctx.fail) or the verdict the tool freezes on. llm_rubric
 * without sampling skips steps 1–2 and admits on recorded verification alone.
 * @module services/eval-record/submit-gate
 */

import type { EvalRecord } from '@/services/eval-record/schema.js';
import { gradeCandidate } from '@/services/grader/grader-service.js';
import type { RecordStoreService } from '@/services/record-store/record-store-service.js';

/** A typed gate failure reason mirrored in the evals_submit_draft error contract. */
export type GateFailureReason =
  | 'grader_failed_on_gold'
  | 'missing_negative_case'
  | 'negative_case_passed'
  | 'verification_incomplete'
  | 'verification_disagrees_with_gold'
  | 'decorrelation_violation'
  | 'duplicate'
  | 'capture_unresolved';

/** A gate failure with a recovery-oriented message and optional structured data. */
export interface GateFailure {
  data?: Record<string, unknown>;
  message: string;
  reason: GateFailureReason;
}

/** The grader-run summary returned on success. */
export interface GraderRun {
  gold: 'PASS' | 'SKIPPED';
  negatives: string;
  positives: string;
  server_verified: boolean;
}

/** The successful gate verdict the tool uses to freeze. */
export interface GateSuccess {
  grader_run: GraderRun;
  record: EvalRecord;
  verification: { decorrelated_by: string; evidence_count: number };
}

/** Discriminated gate result. */
export type GateResult = { ok: true; value: GateSuccess } | { ok: false; failure: GateFailure };

/** Resolve a captured value to a comparable string for the gold cross-check. */
function captureValueString(structuredContent: unknown): string | undefined {
  if (structuredContent === null || structuredContent === undefined) return;
  if (typeof structuredContent === 'object') return JSON.stringify(structuredContent);
  return String(structuredContent);
}

/** Extract the decorrelation source label and verification path from the evidence. */
function describeVerification(record: EvalRecord): {
  decorrelatedBy: string;
  verificationPath: string;
  evidenceCount: number;
} {
  const evidence = record.verification.evidence;
  const subagent = evidence.find((e) => e.type === 'subagent_review');
  let decorrelatedBy: string;
  if (subagent && subagent.type === 'subagent_review') {
    decorrelatedBy = `subagent (${subagent.model})`;
  } else if (evidence.some((e) => e.type === 'source_lookup')) {
    decorrelatedBy = 'live source lookup';
  } else if (evidence.some((e) => e.type === 'deterministic_check')) {
    decorrelatedBy = 'deterministic re-derivation';
  } else {
    decorrelatedBy = `author check (${record.verification.method})`;
  }
  // The verification "path" — the subagent's method when present, else the record's method.
  const verificationPath =
    subagent && subagent.type === 'subagent_review' && subagent.method
      ? subagent.method
      : record.verification.method;
  return { decorrelatedBy, verificationPath, evidenceCount: evidence.length };
}

/**
 * Run the full committability gate against a draft. Pure except for the two
 * async store reads (capture resolution + dedup); never mutates or persists —
 * the caller freezes on `ok: true`. `samplingAvailable` is true when the client
 * exposes ctx.sample (then llm_rubric is graded by the caller and passed in via
 * `llmRubricVerdict`); otherwise llm_rubric admits on recorded verification.
 */
export async function runSubmitGate(
  record: EvalRecord,
  store: RecordStoreService,
  opts: {
    samplingAvailable: boolean;
    llmRubricGoldPass?: boolean;
    llmRubricNegativeRejected?: boolean[];
  },
): Promise<GateResult> {
  const isLlmRubric = record.grader.kind === 'llm_rubric';
  const serverVerified = !isLlmRubric || opts.samplingAvailable;

  let goldStatus: 'PASS' | 'SKIPPED' = 'SKIPPED';
  let positivesSummary = 'SKIPPED';
  let negativesSummary = 'SKIPPED';

  // ---- Step 1+2: deterministic committability (skipped for llm_rubric w/o sampling) ----
  if (serverVerified) {
    // Step 1 — gold must pass.
    if (isLlmRubric) {
      if (opts.llmRubricGoldPass !== true) {
        return {
          ok: false,
          failure: {
            reason: 'grader_failed_on_gold',
            message:
              'The llm_rubric judge did not score the gold as PASS. Fix the gold, the rubric, or the threshold before submitting.',
          },
        };
      }
    } else {
      const goldResult = gradeCandidate(record.grader, record.gold, record.gold, record.choices);
      if (!goldResult.pass) {
        return {
          ok: false,
          failure: {
            reason: 'grader_failed_on_gold',
            message: `The declared grader did not return PASS against the declared gold (${goldResult.detail}). Fix the gold or the grader before submitting.`,
            data: { detail: goldResult.detail },
          },
        };
      }
      const positivesPass = record.discrimination.positive.map(
        (p) => gradeCandidate(record.grader, p, record.gold, record.choices).pass,
      );
      positivesSummary = `${positivesPass.filter(Boolean).length}/${positivesPass.length} PASS`;
    }
    goldStatus = 'PASS';

    // Step 2 — at least one negative, all negatives rejected.
    if (record.discrimination.negative.length === 0) {
      return {
        ok: false,
        failure: {
          reason: 'missing_negative_case',
          message:
            'discrimination.negative is empty — add at least one known-wrong answer so the grader can prove it rejects a wrong answer.',
        },
      };
    }
    const negativeVerdicts = isLlmRubric
      ? (opts.llmRubricNegativeRejected ?? record.discrimination.negative.map(() => false))
      : record.discrimination.negative.map(
          (n) => !gradeCandidate(record.grader, n, record.gold, record.choices).pass,
        );
    const firstAccepted = negativeVerdicts.findIndex((rejected) => !rejected);
    if (firstAccepted !== -1) {
      const offending = record.discrimination.negative[firstAccepted];
      return {
        ok: false,
        failure: {
          reason: 'negative_case_passed',
          message: `Negative case ${JSON.stringify(offending)} passed the grader when it should be rejected — the grader accepts a wrong answer. Tighten the grader or fix the negative case.`,
          data: { index: firstAccepted, candidate: offending },
        },
      };
    }
    negativesSummary = `${negativeVerdicts.filter(Boolean).length}/${negativeVerdicts.length} REJECTED`;
  } else {
    // llm_rubric without sampling: still require a negative case is declared (the discrimination contract).
    if (record.discrimination.negative.length === 0) {
      return {
        ok: false,
        failure: {
          reason: 'missing_negative_case',
          message:
            'discrimination.negative is empty — declare at least one known-wrong answer even when llm_rubric grading runs out-of-band.',
        },
      };
    }
  }

  // ---- Step 3: recorded independent verification, agreement, decorrelation ----
  if (record.verification.evidence.length === 0) {
    return {
      ok: false,
      failure: {
        reason: 'verification_incomplete',
        message:
          'No recorded independent verification. Record a subagent report or your own decorrelated check on verification.evidence before submitting.',
      },
    };
  }

  const { decorrelatedBy, verificationPath, evidenceCount } = describeVerification(record);

  // Decorrelation: the verification path must differ from the generation path.
  const generationPath = record.verification.generation_method;
  if (
    generationPath &&
    verificationPath &&
    generationPath.trim().toLowerCase() === verificationPath.trim().toLowerCase()
  ) {
    return {
      ok: false,
      failure: {
        reason: 'decorrelation_violation',
        message: `The recorded verification path ("${verificationPath}") is the same as the generation path ("${generationPath}") — that is not genuine independence. Verify the gold by a different method.`,
        data: { generation_method: generationPath, verification_method: verificationPath },
      },
    };
  }

  // Agreement: any deterministic-check evidence that computed a value must agree with gold.
  if (!isLlmRubric) {
    for (const ev of record.verification.evidence) {
      if (ev.type === 'deterministic_check' && ev.computed !== undefined) {
        const computedResult = gradeCandidate(
          record.grader,
          ev.computed,
          record.gold,
          record.choices,
        );
        if (!computedResult.pass || ev.passed === false) {
          return {
            ok: false,
            failure: {
              reason: 'verification_disagrees_with_gold',
              message: `An independent verification computed ${JSON.stringify(ev.computed)} which disagrees with the gold (${computedResult.detail}). Fix the gold or the grader before submitting.`,
              data: { computed: ev.computed, gold: record.gold },
            },
          };
        }
      }
    }
  }

  // ---- Step 4: capture resolution + dedup ----
  // Capture resolution happens in the tool (it mutates captured_outputs); the gate only confirms dedup here.
  const dup = await store.findSubmittedDuplicate(record.content_hash, record.id);
  if (dup) {
    return {
      ok: false,
      failure: {
        reason: 'duplicate',
        message: `A submitted record with the same content_hash already exists (${dup}). This is a duplicate; discard this draft or change the task content.`,
        data: { existing_id: dup, content_hash: record.content_hash },
      },
    };
  }

  return {
    ok: true,
    value: {
      record,
      grader_run: {
        gold: goldStatus,
        positives: positivesSummary,
        negatives: negativesSummary,
        server_verified: serverVerified,
      },
      verification: { decorrelated_by: decorrelatedBy, evidence_count: evidenceCount },
    },
  };
}

export { captureValueString };
