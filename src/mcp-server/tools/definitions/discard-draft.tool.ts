/**
 * @fileoverview evals_discard_draft — delete a draft record by id, letting a
 * batch-authoring agent clean up abandoned drafts. Draft-only: submitted records
 * are frozen and raise record_frozen; an unknown id raises not_found. Effectively
 * idempotent — discarding an already-gone draft raises not_found rather than a
 * distinct "already discarded" error.
 * @module mcp-server/tools/definitions/discard-draft.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

export const discardDraftTool = tool('evals_discard_draft', {
  title: 'evals-mcp-server: discard draft',
  description:
    'Delete a draft record by id to clean up an abandoned draft. Draft-only — submitted records are frozen and cannot be discarded. Treat a not_found result on discard as effectively idempotent: a draft that is already gone reports not_found rather than a distinct already-discarded error.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    draft_id: z.string().describe('The draft record id to delete.'),
  }),
  output: z.object({
    id: z.string().describe('The id that was discarded.'),
    discarded: z.literal(true).describe('Always true on success — the draft file was removed.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No draft exists with the given id (never created, or already discarded).',
      recovery: 'Use evals_list_records with status=draft to find a valid draft id, then retry.',
    },
    {
      reason: 'record_frozen',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The id refers to a submitted (frozen) record, which cannot be discarded.',
      recovery: 'Submitted records are permanent; there is nothing to discard.',
    },
  ],

  async handler(input, ctx) {
    await getRecordStoreService().deleteDraft(input.draft_id, ctx);
    return { id: input.draft_id, discarded: true as const };
  },

  format: (result) => [{ type: 'text', text: `Discarded draft ${result.id}.` }],
});
