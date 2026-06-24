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
    'Browse and filter eval records by status, domain, task_type, or tag. Returns a compact summary per record (id, status, task_type, domain, tags, timestamps), not the full records — call evals_get_record for a single record in full. Results are newest-first and the response discloses when the limit truncated the set.',
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
      .max(500)
      .default(50)
      .describe('Maximum number of summaries to return.'),
  }),
  output: z.object({
    records: z.array(RecordSummarySchema).describe('The matching record summaries, newest-first.'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe('Total records matching the filter before the limit was applied.'),
    truncated: z.boolean().describe('True when the limit truncated the matching set.'),
    shown: z.number().describe('Number of summaries returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Guidance when no records matched the filter.'),
  },

  async handler(input, ctx) {
    const { summaries, total, truncated } = await getRecordStoreService().listSummaries({
      ...(input.status ? { status: input.status } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.task_type ? { task_type: input.task_type } : {}),
      ...(input.tag ? { tag: input.tag } : {}),
      limit: input.limit,
    });

    ctx.enrich.total(total);
    if (truncated) {
      ctx.enrich.truncated({
        shown: summaries.length,
        cap: input.limit,
        guidance: `Showing the ${input.limit} newest of ${total}; narrow with a status/domain/task_type/tag filter or raise limit (max 500).`,
      });
    } else {
      ctx.enrich({ truncated: false, shown: summaries.length, cap: input.limit });
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
      ctx.enrich.notice(
        `No records matched${applied ? ` (${applied})` : ''}. Try a broader filter or call evals_create_draft to author one.`,
      );
    }
    ctx.log.debug('Listed records', { total, shown: summaries.length });
    return { records: summaries };
  },

  format: (result) => {
    if (result.records.length === 0)
      return [{ type: 'text', text: 'No records matched the filter.' }];
    const lines = result.records.map(
      (r) =>
        `- **${r.id}** (${r.status}) · ${r.task_type} · ${r.domain}${r.tags.length ? ` · [${r.tags.join(', ')}]` : ''} · created ${r.created_at}${r.submitted_at ? ` · submitted ${r.submitted_at}` : ''}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
