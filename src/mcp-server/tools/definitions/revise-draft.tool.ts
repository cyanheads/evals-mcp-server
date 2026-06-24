/**
 * @fileoverview evals_revise_draft — apply a surgical, field-level patch (set /
 * append / unset by dotted path) to a draft. Returns the updated record, the
 * normalized list of what changed (the legibility mechanism), and a re-run of the
 * self-consistency check (the grader may have changed). Draft-only: submitted
 * records are frozen. Setting task_type is prohibited — start a new draft to
 * change the discriminant.
 * @module mcp-server/tools/definitions/revise-draft.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  assertTaskTypeConstraints,
  hasRecordedVerification,
} from '@/services/eval-record/record-builder.js';
import {
  EvalRecordSchema,
  RecordPayloadSchema,
  SelfConsistencySchema,
} from '@/services/eval-record/schema.js';
import { checkSelfConsistency } from '@/services/grader/grader-service.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

export const reviseDraftTool = tool('evals_revise_draft', {
  title: 'evals-mcp-server: revise draft',
  description:
    'Apply a surgical, field-level patch to a draft using explicit set / append / unset operations by dotted path (e.g. set "grader.rel_tol", append "verification.evidence"), not a full rewrite, so the change stays legible. Returns the updated record, an itemized list of what changed, and a re-run of the self-consistency check since the grader may have moved. Draft-only — submitted records are frozen.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({
    draft_id: z.string().describe('The draft record id to patch.'),
    set: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Dotted-path → value replacements, e.g. {"grader.rel_tol": 0.001}. Cannot target task_type or server-owned fields.',
      ),
    append: z
      .record(z.string(), z.array(z.unknown()))
      .optional()
      .describe(
        'Dotted-path → items appended to an array field, e.g. {"discrimination.positive": ["0.357"]}.',
      ),
    unset: z
      .array(z.string())
      .optional()
      .describe('Dotted paths to remove from the record, e.g. ["metadata.contamination_notes"].'),
  }),
  output: z.object({
    record: RecordPayloadSchema.describe('The updated draft record after the patch.'),
    changed: z
      .array(
        z
          .object({
            op: z.enum(['set', 'append', 'unset']).describe('The operation applied.'),
            path: z.string().describe('The dotted path that was changed.'),
            before: z
              .unknown()
              .optional()
              .describe('The value before the change (absent for created paths).'),
            after: z
              .unknown()
              .optional()
              .describe('The value after the change (absent for unset).'),
          })
          .describe('One applied patch operation with its before/after values.'),
      )
      .describe('The itemized changes applied, in order — the legibility record.'),
    server_checks: z
      .object({
        self_consistency: SelfConsistencySchema.describe('The re-run self-consistency verdict.'),
      })
      .describe('The re-run self-consistency result after the patch.'),
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
      when: 'The target id refers to a submitted (frozen) record.',
      recovery:
        'Submitted records are immutable; author a new draft with evals_create_draft instead.',
    },
    {
      reason: 'invalid_patch_path',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A set/unset path does not resolve, an append targets a non-array, or a protected field (task_type, id, checksum) was targeted.',
      recovery:
        'Use a path that resolves against the record shape; do not target task_type or server-owned fields.',
    },
    {
      reason: 'task_type_constraint',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The patch left the record violating a per-task-type rule (mcq correct not in choices; free_response without llm_rubric grader).',
      recovery: 'Adjust choices/grader so the task-type constraint holds, then retry.',
    },
    {
      reason: 'mcq_choice_mismatch',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'After the patch, the mcq grader correct answer is not one of the choices.',
      recovery: 'Set grader.correct to one of the choices, or fix the choices array, then retry.',
    },
  ],

  async handler(input, ctx) {
    const store = getRecordStoreService();
    const existing = await store.require(input.draft_id);
    if (existing.status === 'submitted') {
      throw ctx.fail(
        'record_frozen',
        `Record "${input.draft_id}" is submitted and frozen; it cannot be revised.`,
        { ...ctx.recoveryFor('record_frozen'), id: input.draft_id },
      );
    }

    const { record: patched, changed } = store.applyPatch(existing, {
      ...(input.set ? { set: input.set } : {}),
      ...(input.append ? { append: input.append } : {}),
      ...(input.unset ? { unset: input.unset } : {}),
    });

    // Re-validate the full shape and the cross-field constraints after the patch.
    const validated = EvalRecordSchema.parse(patched);
    assertTaskTypeConstraints(validated);

    await store.writeDraft(validated, ctx);

    const checks = checkSelfConsistency(
      validated.grader,
      validated.gold,
      validated.discrimination.positive,
      validated.discrimination.negative,
      validated.choices,
      hasRecordedVerification(validated),
    );

    ctx.log.info('Revised draft', {
      id: validated.id,
      ops: changed.length,
      grader_ok: checks.grader_ok,
    });
    return { record: validated, changed, server_checks: { self_consistency: checks } };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`Patched ${result.record.id} — ${result.changed.length} change(s):`);
    for (const c of result.changed) {
      const before = c.before === undefined ? '∅' : JSON.stringify(c.before);
      const after = c.after === undefined ? '∅' : JSON.stringify(c.after);
      lines.push(`- ${c.op} \`${c.path}\` — before: ${before} → after: ${after}`);
    }
    const sc = result.server_checks.self_consistency;
    lines.push(
      '',
      `**self-consistency:** grader_ok=${sc.grader_ok}, verification_present=${sc.verification_present}, ready_to_submit=${sc.ready_to_submit}`,
    );
    lines.push(
      `gold passes: ${sc.gold_passes_grader} · positives: ${sc.positives_pass.filter(Boolean).length}/${sc.positives_pass.length} · negatives rejected: ${sc.negatives_rejected.filter(Boolean).length}/${sc.negatives_rejected.length}`,
    );
    lines.push('', '**updated record:**', '```json', JSON.stringify(result.record, null, 2), '```');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
