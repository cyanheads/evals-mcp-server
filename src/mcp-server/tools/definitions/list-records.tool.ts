/**
 * @fileoverview evals_list_records — browse and filter records by status, domain,
 * task_type, or tag. Returns a summary projection per record (not full records),
 * sorted newest-first, and discloses truncation when the limit is hit so a
 * partial set is never mistaken for the whole corpus.
 * @module mcp-server/tools/definitions/list-records.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  RecordSummarySchema,
  StatusSchema,
  TaskTypeSchema,
} from '@/services/eval-record/schema.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

export const listRecordsTool = tool('evals_list_records', {
  title: 'evals-mcp-server: list records',
  description:
    'Browse and filter eval records by status, domain, task_type, or tag. Returns compact summaries (id, status, task_type, domain, tags, timestamps), newest-first. Pass nextOffset as offset to continue. Call evals_get_record for a full record.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    status: StatusSchema.optional().describe('Filter to draft-only or submitted-only records.'),
    domain: z
      .string()
      .optional()
      .describe('Filter to records whose metadata.domain equals this value.'),
    task_type: TaskTypeSchema.optional().describe('Filter to records of this task type.'),
    tag: z.string().optional().describe('Filter to records carrying this tag.'),
    limit: z
      .number()
      .int()
      .positive()
      .default(50)
      .describe('Maximum number of summaries to return.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe('Number of matching summaries to skip.'),
  }),
  output: z.object({
    records: z.array(RecordSummarySchema).describe('The matching record summaries, newest-first.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total records matching the filter before pagination.'),
    truncated: z.boolean().describe('True when more matches follow this page.'),
    shown: z.number().describe('Number of summaries returned.'),
    cap: z.number().describe('The limit that was applied.'),
    nextOffset: z.number().int().optional().describe('Offset to request the next page.'),
    notice: z.string().optional().describe('Guidance for empty pages or skipped record files.'),
  },

  async handler(input, ctx) {
    const { summaries, total, truncated, nextOffset, skipped } =
      await getRecordStoreService().listSummaries({
        ...(input.status ? { status: input.status } : {}),
        ...(input.domain ? { domain: input.domain } : {}),
        ...(input.task_type ? { task_type: input.task_type } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
        limit: input.limit,
        offset: input.offset,
      });

    ctx.enrich.total(total);
    ctx.enrich({ truncated, shown: summaries.length, cap: input.limit });
    const notices: string[] = [];
    if (nextOffset !== undefined) {
      ctx.enrich({ nextOffset });
      notices.push(`More records follow. Pass nextOffset (${nextOffset}) as offset to continue.`);
    }
    if (total === 0) {
      const applied = [
        input.status && `status=${input.status}`,
        input.domain && `domain=${input.domain}`,
        input.task_type && `task_type=${input.task_type}`,
        input.tag && `tag=${input.tag}`,
      ]
        .filter(Boolean)
        .join(', ');
      notices.push(
        `No records matched${applied ? ` (${applied})` : ''}. Try a broader filter or call evals_create_draft to author one.`,
      );
    } else if (summaries.length === 0) {
      notices.push(`No records at offset ${input.offset}; ${total} matched. Use a smaller offset.`);
    }
    if (skipped.length) notices.push(`Skipped invalid record files: ${skipped.join(', ')}.`);
    if (notices.length) ctx.enrich.notice(notices.join(' '));
    ctx.log.debug('Listed records', { total, shown: summaries.length });
    return { records: summaries };
  },

  format: (result) => {
    if (result.records.length === 0) return [{ type: 'text', text: 'No records on this page.' }];
    const lines = result.records.map(
      (r) =>
        `- **${r.id}** (${r.status}) · ${r.task_type} · ${r.domain}${r.tags.length ? ` · [${r.tags.join(', ')}]` : ''} · created ${r.created_at}${r.submitted_at ? ` · submitted ${r.submitted_at}` : ''}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
