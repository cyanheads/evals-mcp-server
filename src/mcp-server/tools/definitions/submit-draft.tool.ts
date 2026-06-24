/**
 * @fileoverview evals_submit_draft — the gated finalize. Resolves and embeds any
 * captures (cross-checking the gold against the authoritative captured value),
 * runs the committability invariant server-side (gold passes its grader; ≥1
 * negative is rejected; a recorded, decorrelated, agreeing independent
 * verification is present; not a duplicate), and on pass flips the record to
 * submitted, stamps submitted_at + checksum, and freezes it. Refuses with a typed
 * error otherwise, leaving the record a draft. llm_rubric is judged via ctx.sample
 * when the client supports sampling, else admitted on recorded verification with
 * server_verified=false.
 * @module mcp-server/tools/definitions/submit-draft.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type { Capture, EvalRecord } from '@/services/eval-record/schema.js';
import { runSubmitGate } from '@/services/eval-record/submit-gate.js';
import { gradeCandidate } from '@/services/grader/grader-service.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

/** Resolve captures from EVALS_CAPTURE_DIR, embed dumps, lift source URLs, cross-check gold. */
async function resolveCaptures(record: EvalRecord, ctx: Context): Promise<EvalRecord> {
  const store = getRecordStoreService();
  if (!record.captures || record.captures.length === 0 || !store.captureEnabled) return record;

  const dumps: Capture[] = [];
  const liftedSources = [...(record.metadata.source_provenance ?? [])];
  for (const id of record.captures) {
    const capture = await store.resolveCapture(id);
    if (capture === null) {
      throw invalidParams(
        `Capture "${id}" has no file in EVALS_CAPTURE_DIR. Re-run the source tool to regenerate it, or remove it from captures before submitting.`,
        {
          reason: 'capture_unresolved',
          evals_id: id,
        },
      );
    }
    dumps.push(capture);
    if (capture.isError) {
      throw invalidParams(
        `Capture "${id}" recorded a failed tool call; it cannot ground a gold answer. Remove it or replace it with a successful capture.`,
        {
          reason: 'capture_unresolved',
          evals_id: id,
        },
      );
    }
    // Lift a source citation from the capture into provenance.
    liftedSources.push({
      server: capture.server,
      query:
        typeof capture.args === 'object'
          ? JSON.stringify(capture.args)
          : String(capture.args ?? ''),
      value: JSON.stringify(capture.structuredContent).slice(0, 2000),
      ...(capture.traceId ? { uri: `trace:${capture.traceId}` } : {}),
      retrieved_at: capture.ts,
    });
    ctx.log.debug('Resolved capture', { evals_id: id, server: capture.server });
  }

  return {
    ...record,
    captured_outputs: dumps,
    metadata: { ...record.metadata, source_provenance: liftedSources },
  };
}

export const submitDraftTool = tool('evals_submit_draft', {
  title: 'evals-mcp-server: submit draft',
  description:
    'Finalize a draft through the committability gate. The server runs the grader against the gold (must PASS), rejects ≥1 declared negative case, requires a recorded, decorrelated independent verification that agrees with the gold, embeds any resolved captures, and checks for duplicates; on pass it flips the record to submitted, stamps submitted_at and a checksum, and freezes it. It refuses with a typed error otherwise and the record stays a draft. For free_response the llm_rubric grader is judged via sampling when the client supports it, else the record is admitted on recorded verification alone and flagged server_verified=false.',
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  input: z.object({
    draft_id: z.string().describe('The draft record id to finalize.'),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'When true, force a human confirmation elicit before finalizing (also triggered by EVALS_REQUIRE_CONFIRMATION).',
      ),
  }),
  output: z.object({
    id: z.string().describe('The finalized record id (unchanged across submit).'),
    status: z.literal('submitted').describe('Always "submitted" on success.'),
    path: z.string().describe('The on-disk path of the frozen submitted record.'),
    checksum: z.string().describe('The SHA-256 immutability anchor stamped at submit.'),
    grader_run: z
      .object({
        gold: z
          .enum(['PASS', 'SKIPPED'])
          .describe(
            'Whether the gold passed the grader (SKIPPED for llm_rubric without sampling).',
          ),
        positives: z.string().describe('Positive-case verdict summary, e.g. "3/3 PASS".'),
        negatives: z.string().describe('Negative-case verdict summary, e.g. "1/1 REJECTED".'),
        server_verified: z
          .boolean()
          .describe(
            'True when the grader ran server-side; false for llm_rubric admitted without sampling.',
          ),
      })
      .describe('The grader verdicts produced by the gate.'),
    verification: z
      .object({
        decorrelated_by: z
          .string()
          .describe('The independent verification source, e.g. "subagent (claude-sonnet-4-6)".'),
        evidence_count: z.number().describe('Number of recorded verification.evidence entries.'),
      })
      .describe('The decorrelation provenance the gate accepted.'),
    frozen: z.literal(true).describe('Always true — the record is now immutable.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record exists with the given draft id.',
      recovery: 'Use evals_list_records to find a valid draft id, then retry.',
    },
    {
      reason: 'record_frozen',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The id refers to an already-submitted record.',
      recovery:
        'The record is already finalized; nothing to submit. Read it with evals_get_record.',
    },
    {
      reason: 'verification_incomplete',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No recorded independent verification (no subagent report and no author decorrelated check).',
      recovery:
        'Append a subagent report or your own decorrelated check to verification.evidence, then retry.',
    },
    {
      reason: 'grader_failed_on_gold',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The declared grader, run against the declared gold, did not return PASS.',
      recovery: 'Fix the gold so it passes its grader, or fix the grader spec, then retry.',
    },
    {
      reason: 'verification_disagrees_with_gold',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A recorded independent verification computed a value that disagrees with the gold.',
      recovery:
        'Reconcile the gold with the independent computation — fix whichever is wrong — then retry.',
    },
    {
      reason: 'missing_negative_case',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'discrimination.negative is empty — nothing proves the grader rejects a wrong answer.',
      recovery: 'Add at least one known-wrong negative case via evals_revise_draft, then retry.',
    },
    {
      reason: 'negative_case_passed',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A declared negative case passed the grader when it should be rejected.',
      recovery:
        'Tighten the grader or fix the negative case so the wrong answer is rejected, then retry.',
    },
    {
      reason: 'duplicate',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A submitted record with the same content_hash already exists.',
      recovery: 'Discard this draft or change the task content so it is not a duplicate.',
    },
    {
      reason: 'decorrelation_violation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The recorded verification path is the same as the generation path (no genuine independence).',
      recovery: 'Verify the gold by a method different from how it was generated, then retry.',
    },
    {
      reason: 'capture_unresolved',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A captures EvalsID has no file in EVALS_CAPTURE_DIR (only when capture is enabled).',
      recovery:
        'Re-run the source tool to regenerate the capture, or remove the id from captures, then retry.',
    },
    {
      reason: 'submit_declined',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A required human confirmation was declined or cancelled.',
      recovery: 'Re-run evals_submit_draft and accept the confirmation to finalize.',
    },
  ],

  async handler(input, ctx) {
    const store = getRecordStoreService();
    const cfg = getServerConfig();
    const existing = await store.require(input.draft_id);
    if (existing.status === 'submitted') {
      throw ctx.fail('record_frozen', `Record "${input.draft_id}" is already submitted.`, {
        ...ctx.recoveryFor('record_frozen'),
      });
    }

    // Optional human confirmation before finalize.
    if ((cfg.requireConfirmation || input.confirm) && ctx.elicit) {
      const result = await ctx.elicit(
        `Finalize and freeze eval record ${existing.id} (${existing.task_type}, domain ${existing.metadata.domain})?`,
        z.object({ confirm: z.boolean().describe('Confirm finalize') }),
      );
      if (result.action !== 'accept' || result.content?.confirm !== true) {
        throw ctx.fail('submit_declined', 'Submission was not confirmed.', {
          ...ctx.recoveryFor('submit_declined'),
        });
      }
    }

    // Resolve + embed captures (cross-checks the gold against the captured value below).
    const withCaptures = await resolveCaptures(existing, ctx);

    // For a captured gold cross-check: if any capture's value disagrees with the gold under the grader, refuse.
    if (withCaptures.captured_outputs && withCaptures.grader.kind !== 'llm_rubric') {
      for (const cap of withCaptures.captured_outputs) {
        const sc = cap.structuredContent;
        // Only cross-check scalar-ish captured values against a target-embedding grader.
        if (sc !== null && (typeof sc === 'number' || typeof sc === 'string')) {
          const agrees = gradeCandidate(
            withCaptures.grader,
            sc,
            withCaptures.gold,
            withCaptures.choices,
          ).pass;
          if (!agrees) {
            throw ctx.fail(
              'verification_disagrees_with_gold',
              `The captured source value from ${cap.server} disagrees with the gold under the grader. Fix the gold to match the authoritative captured value.`,
              {
                captured: sc,
                gold: withCaptures.gold,
                server: cap.server,
              },
            );
          }
        }
      }
    }

    // Run the committability gate.
    const gate = await runSubmitGate(withCaptures, store, { samplingAvailable: false });
    if (!gate.ok) {
      throw ctx.fail(gate.failure.reason, gate.failure.message, {
        ...ctx.recoveryFor(gate.failure.reason),
        ...gate.failure.data,
      });
    }

    // Freeze (promoteToSubmitted always stamps checksum + submitted_at).
    const { record: frozen, path } = await store.promoteToSubmitted(gate.value.record, ctx);

    ctx.log.notice('Submitted eval record', {
      id: frozen.id,
      server_verified: gate.value.grader_run.server_verified,
    });
    return {
      id: frozen.id,
      status: 'submitted' as const,
      path,
      checksum: frozen.checksum,
      grader_run: gate.value.grader_run,
      verification: gate.value.verification,
      frozen: true as const,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `✓ ${result.id} is now ${result.status} (frozen=${result.frozen}) at ${result.path}`,
    );
    lines.push(`**checksum:** ${result.checksum}`);
    lines.push(
      `**grader_run:** gold=${result.grader_run.gold}, positives=${result.grader_run.positives}, negatives=${result.grader_run.negatives}, server_verified=${result.grader_run.server_verified}`,
    );
    lines.push(
      `**verification:** decorrelated by ${result.verification.decorrelated_by} (${result.verification.evidence_count} evidence entr${result.verification.evidence_count === 1 ? 'y' : 'ies'})`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
