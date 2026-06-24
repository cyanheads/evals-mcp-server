/**
 * @fileoverview evals_export_records — compile submitted records (all, or by
 * filter) to a downstream format: jsonl (lossless), csv (flattened, lossy),
 * inspect (Inspect AI), or lm-eval (lm-evaluation-harness). Writes the artifact
 * under exports/ and returns its path plus a preview, avoiding a multi-MB inline
 * dump. Only submitted records are exported; drafts are excluded.
 * @module mcp-server/tools/definitions/export-records.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { EvalRecord } from '@/services/eval-record/schema.js';
import { TaskTypeSchema } from '@/services/eval-record/schema.js';
import {
  EXPORT_EXTENSION,
  type ExportFormat,
  getExporterService,
} from '@/services/exporter/exporter-service.js';
import { getRecordStoreService } from '@/services/record-store/record-store-service.js';

export const exportRecordsTool = tool('evals_export_records', {
  title: 'evals-mcp-server: export records',
  description:
    'Compile submitted records to a downstream eval format and write the artifact under exports/. Choose jsonl (lossless, the lingua franca), csv (a flattened, lossy spreadsheet summary), inspect (UK AISI Inspect AI), or lm-eval (EleutherAI lm-evaluation-harness). Optionally filter by domain, task_type, or tag. Only submitted records are exported — drafts are skipped. Returns the file path, record count, byte size, and a short preview rather than dumping the full artifact inline.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    format: z
      .enum(['jsonl', 'csv', 'inspect', 'lm-eval'])
      .describe('The downstream format to compile to.'),
    domain: z
      .string()
      .optional()
      .describe('Export only records whose metadata.domain equals this value.'),
    task_type: TaskTypeSchema.optional().describe('Export only records of this task type.'),
    tag: z.string().optional().describe('Export only records carrying this tag.'),
  }),
  output: z.object({
    path: z.string().describe('The on-disk path of the written export artifact.'),
    format: z
      .enum(['jsonl', 'csv', 'inspect', 'lm-eval'])
      .describe('The format that was compiled.'),
    record_count: z.number().describe('Number of submitted records included in the export.'),
    bytes: z.number().describe('Byte size of the written artifact.'),
    preview: z.string().describe('The first ~20 lines/rows of the artifact.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when no submitted records matched the filter.'),
  },

  async handler(input, ctx) {
    const store = getRecordStoreService();
    const all = await store.listSubmittedRecords();
    const filtered: EvalRecord[] = all.filter(
      (r) =>
        (!input.domain || r.metadata.domain === input.domain) &&
        (!input.task_type || r.task_type === input.task_type) &&
        (!input.tag || r.metadata.tags.includes(input.tag)),
    );

    const format = input.format as ExportFormat;
    const { content, preview } = getExporterService().compile(filtered, format);

    const filterStem =
      [input.domain, input.task_type, input.tag].filter(Boolean).join('-') || 'all';
    const stem = `${format}-${filterStem}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const { path, bytes } = await store.writeExport(stem, EXPORT_EXTENSION[format], content, ctx);

    if (filtered.length === 0) {
      const applied = [
        input.domain && `domain=${input.domain}`,
        input.task_type && `task_type=${input.task_type}`,
        input.tag && `tag=${input.tag}`,
      ]
        .filter(Boolean)
        .join(', ');
      ctx.enrich.notice(
        `No submitted records matched${applied ? ` (${applied})` : ''}; wrote an empty ${format} artifact. Submit records with evals_submit_draft first.`,
      );
    }

    ctx.log.info('Exported records', { format, count: filtered.length, path });
    return { path, format: input.format, record_count: filtered.length, bytes, preview };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `Wrote ${result.record_count} record(s) as ${result.format} → ${result.path} (${result.bytes} bytes)`,
    );
    if (result.preview.trim().length > 0) {
      lines.push('', '```', result.preview, '```');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
