/**
 * @fileoverview evals_get_record — read a draft or submitted record by id. The
 * verification subagent's entry point: it reads the draft here, re-derives or
 * looks up the gold, and reports back without mutating anything. The id is stable
 * across submit, so a record resolves before and after finalize.
 * @module mcp-server/tools/definitions/get-record.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type EvalRecord, RecordPayloadSchema } from '@/services/eval-record/schema.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

export const getRecordTool = tool('evals_get_record', {
  title: 'evals-mcp-server: get record',
  description:
    'Read a draft or submitted eval record by id. The verification subagent calls this to inspect a draft before re-deriving or looking up the gold. The id is stable across submit, so it resolves a record whether it is still a draft or already submitted.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    id: z.string().describe('The record id to read, e.g. "ev_7Qk2mNpXa".'),
  }),
  output: z.object({
    record: RecordPayloadSchema.describe(
      'The full eval record, including its grader, discrimination cases, and verification evidence.',
    ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record exists with the given id.',
      recovery:
        'Use evals_list_records to browse existing record ids, then retry with a valid one.',
    },
  ],

  async handler(input, ctx) {
    const record = await getRecordStoreService().require(input.id);
    ctx.log.debug('Read record', { id: record.id, status: record.status });
    return { record };
  },

  format: (result) => {
    const r = result.record as EvalRecord;
    const lines: string[] = [];
    lines.push(`# ${r.id}  (${r.status})`);
    lines.push(`**task_type:** ${r.task_type}  ·  **domain:** ${r.metadata.domain}`);
    lines.push(`**prompt:** ${r.prompt}`);
    if (r.context) lines.push(`**context:** ${r.context}`);
    lines.push(`**gold:** ${typeof r.gold === 'object' ? JSON.stringify(r.gold) : String(r.gold)}`);
    lines.push('```json');
    lines.push(JSON.stringify(r, null, 2));
    lines.push('```');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
