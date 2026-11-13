/**
 * @fileoverview The submit gate — the committability invariant enforced
 * mechanically at evals_submit_draft. Runs the grader against gold (must PASS)
 * and each negative (≥1, must REJECT), asserts a recorded independent
 * verification exists and agrees with gold, enforces decorrelation (the
 * verification path must differ from the generation path), and checks
 * content_hash dedup. Returns a typed failure (which
 * the tool maps to ctx.fail) or the verdict the tool freezes on. llm_rubric
 * skips steps 1–2 and admits on recorded verification alone.
 * @module services/eval-record/submit-gate
 */

import type { EvalRecord } from '@/services/eval-record/schema.js';
import {
  gradeCandidate,
  gradeDiscrimination,
  type SelfConsistency,
} from '@/services/grader/grader-service.js';
import type { RecordStoreService } from '@/services/record-store/record-store-service.js';

/** A typed gate failure reason mirrored in the evals_submit_draft error contract. */
export type GateFailureReason =
  | 'grader_failed_on_gold'
  | 'positive_case_failed'
  | 'missing_negative_case'
  | 'negative_case_passed'
  | 'verification_incomplete'
  | 'verification_disagrees_with_gold'
  | 'decorrelation_violation'
  | 'duplicate';

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
  skipped: string[];
  verification: { decorrelated_by: string; evidence_count: number };
}

/** Discriminated gate result. */
export type GateResult = { ok: true; value: GateSuccess } | { ok: false; failure: GateFailure };

/** Extract the decorrelation source label and verification path from the evidence. */
function describeVerification(record: EvalRecord): {
  decorrelatedBy: string;
  verificationPath: string;
  evidenceCount: number;
} {
  const evidence = record.verification.evidence;
  const subagent = evidence.find((e) => e.type === 'subagent_review');
  let decorrelatedBy: string;
  if (subagent) {
    decorrelatedBy = `subagent (${subagent.model})`;
  } else if (evidence.some((e) => e.type === 'source_lookup')) {
    decorrelatedBy = 'live source lookup';
  } else if (evidence.some((e) => e.type === 'deterministic_check')) {
    decorrelatedBy = 'deterministic re-derivation';
  } else {
    decorrelatedBy = `author check (${record.verification.method})`;
  }
  // The verification "path" — the subagent's method when present, else the record's method.
  const verificationPath = subagent?.method || record.verification.method;
  return { decorrelatedBy, verificationPath, evidenceCount: evidence.length };
}

/** Evaluate draft-local conditions without resolving captures or reading the store. */
export function checkDraft(record: EvalRecord): {
  checks: SelfConsistency;
  failures: GateFailure[];
  verification: GateSuccess['verification'];
} {
  const { grader, gold, choices, discrimination } = record;
  const rubric = grader.kind === 'llm_rubric';
  const { goldDetail, ...verdicts } = gradeDiscrimination(
    grader,
    gold,
    discrimination.positive,
    discrimination.negative,
    choices,
  );
  const failures: GateFailure[] = [];
  if (!rubric) {
    if (!verdicts.gold_passes_grader) {
      failures.push({
        reason: 'grader_failed_on_gold',
        message: `The declared grader did not return PASS against the declared gold (${goldDetail}). Fix the gold or the grader before submitting.`,
        data: { detail: goldDetail },
      });
    }
    for (const [index, pass] of verdicts.positives_pass.entries()) {
      if (pass) continue;
      const candidate = discrimination.positive[index];
      failures.push({
        reason: 'positive_case_failed',
        message: `Positive case ${index} (${JSON.stringify(candidate)}) failed the grader. Fix the grader or the positive case.`,
        data: { index, candidate },
      });
    }
  }

  if (discrimination.negative.length === 0) {
    failures.push({
      reason: 'missing_negative_case',
      message: rubric
        ? 'Declare at least one known-wrong answer in discrimination.negative for out-of-band rubric grading.'
        : 'Add at least one known-wrong answer in discrimination.negative that the grader rejects.',
    });
  } else if (!rubric) {
    for (const [index, rejected] of verdicts.negatives_rejected.entries()) {
      if (rejected) continue;
      const candidate = discrimination.negative[index];
      failures.push({
        reason: 'negative_case_passed',
        message: `Negative case ${index} (${JSON.stringify(candidate)}) passed the grader. Tighten the grader or fix the negative case.`,
        data: { index, candidate },
      });
    }
  }

  const { decorrelatedBy, verificationPath, evidenceCount } = describeVerification(record);
  const generationPath = record.verification.generation_method;
  if (evidenceCount === 0) {
    failures.push({
      reason: 'verification_incomplete',
      message:
        'Record a subagent report or your own decorrelated check in verification.evidence before submitting.',
    });
  } else if (
    generationPath &&
    verificationPath &&
    generationPath.trim().toLowerCase() === verificationPath.trim().toLowerCase()
  ) {
    failures.push({
      reason: 'decorrelation_violation',
      message: `The recorded verification path ("${verificationPath}") is the same as the generation path ("${generationPath}"). Verify the gold by a different method.`,
      data: { generation_method: generationPath, verification_method: verificationPath },
    });
  }

  for (const [index, evidence] of record.verification.evidence.entries()) {
    if (evidence.type !== 'deterministic_check') continue;
    const { passed, computed } = evidence;
    if (!passed) {
      failures.push({
        reason: 'verification_disagrees_with_gold',
        message: `Deterministic check ${index} records passed: false. Resolve the failed verification before submitting.`,
        data: { index, ...(computed === undefined ? {} : { computed }), gold },
      });
    } else if (!rubric && computed !== undefined) {
      const result = gradeCandidate(grader, computed, gold, choices);
      if (!result.pass) {
        failures.push({
          reason: 'verification_disagrees_with_gold',
          message: `Deterministic check ${index} computed ${JSON.stringify(computed)}, which disagrees with the gold (${result.detail}). Fix the gold or the grader before submitting.`,
          data: { index, computed, gold },
        });
      }
    }
  }

  return {
    checks: {
      ...verdicts,
      verification_present: evidenceCount > 0,
      ready_to_submit: failures.length === 0,
    },
    failures,
    verification: { decorrelated_by: decorrelatedBy, evidence_count: evidenceCount },
  };
}

/** Run the draft-local checks, then read submitted records for deduplication. */
export async function runSubmitGate(
  record: EvalRecord,
  store: RecordStoreService,
): Promise<GateResult> {
  const { checks, failures, verification } = checkDraft(record);
  const [failure] = failures;
  if (failure) return { ok: false, failure };

  const serverVerified = record.grader.kind !== 'llm_rubric';

  // ---- Step 4: dedup ----
  const { duplicateId, skipped } = await store.findSubmittedDuplicate(
    record.content_hash,
    record.id,
  );
  if (duplicateId) {
    return {
      ok: false,
      failure: {
        reason: 'duplicate',
        message: `A submitted record with the same content_hash already exists (${duplicateId}). This is a duplicate; discard this draft or change the task content.${skipped.length ? ` Skipped invalid record files: ${skipped.join(', ')}.` : ''}`,
        data: {
          existing_id: duplicateId,
          content_hash: record.content_hash,
          ...(skipped.length ? { skipped } : {}),
        },
      },
    };
  }

  return {
    ok: true,
    value: {
      record,
      skipped,
      grader_run: {
        gold: serverVerified ? 'PASS' : 'SKIPPED',
        positives: serverVerified
          ? `${checks.positives_pass.length}/${checks.positives_pass.length} PASS`
          : 'SKIPPED',
        negatives: serverVerified
          ? `${checks.negatives_rejected.length}/${checks.negatives_rejected.length} REJECTED`
          : 'SKIPPED',
        server_verified: serverVerified,
      },
      verification,
    },
  };
}
