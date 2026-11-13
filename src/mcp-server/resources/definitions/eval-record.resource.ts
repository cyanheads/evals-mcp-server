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
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { RecordObjectSchema } from '@/services/eval-record/schema.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

/** List the records currently available through the eval:// resource surface. */
export async function listEvalRecordResources() {
  const { summaries, skipped } = await getRecordStoreService().listSummaries({});
  if (skipped.length) {
    logger.warning(`Resource discovery skipped invalid record files: ${skipped.join(', ')}.`);
  }
  return {
    resources: summaries.map((summary) => ({
      uri: `eval://record/${summary.id}`,
      name: `${summary.id} (${summary.status})`,
      title: 'eval-record',
    })),
  };
}

export const evalRecordResource = resource('eval://record/{id}', {
  name: 'eval-record',
  title: 'eval-record',
  description:
    'A single draft or submitted eval record by id — the same payload evals_get_record returns, for resource-capable clients.',
  mimeType: 'application/json',
  params: z.object({
    id: z
      .string()
      .describe('The record id returned by an authoring response or evals_list_records.'),
  }),
  output: RecordObjectSchema,
  errors: [
    {
      reason: 'record_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The stored file could not be decoded as a valid record.',
      recovery: 'Repair the named record file, then retry.',
      thrownBy: 'service',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record exists with the given id.',
      recovery: 'Use evals_list_records to browse valid record ids, then retry.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    const record = await getRecordStoreService().require(params.id);
    ctx.log.debug('Resolved record resource', { id: record.id, status: record.status });
    return record;
  },

  list: listEvalRecordResources,
});
