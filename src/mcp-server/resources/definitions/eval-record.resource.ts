/**
 * @fileoverview eval://record/{id} — a single draft or submitted record by id, as
 * injectable context for resource-capable clients. The same payload
 * evals_get_record returns; the id is stable across submit, so the URI resolves
 * before and after finalize. A convenience mirror — every record is also reachable
 * through the tool surface (evals_get_record / evals_list_records).
 * @module mcp-server/resources/definitions/eval-record.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { RecordObjectSchema } from '@/services/eval-record/schema.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

export const evalRecordResource = resource('eval://record/{id}', {
  name: 'eval-record',
  title: 'eval-record',
  description:
    'A single draft or submitted eval record by id — the same payload evals_get_record returns, for resource-capable clients.',
  mimeType: 'application/json',
  params: z.object({
    id: z.string().describe('The record id, e.g. "ev_7Qk2mNpXa".'),
  }),
  output: RecordObjectSchema,
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record exists with the given id.',
      recovery: 'Use evals_list_records to browse valid record ids, then retry.',
    },
  ],

  async handler(params, ctx) {
    const record = await getRecordStoreService().require(params.id);
    ctx.log.debug('Resolved record resource', { id: record.id, status: record.status });
    return record;
  },

  list: async () => {
    const { summaries } = await getRecordStoreService().listSummaries({ limit: 100 });
    return {
      resources: summaries.map((s) => ({
        uri: `eval://record/${s.id}`,
        name: `${s.id} (${s.status})`,
      })),
    };
  },
});
