/**
 * @fileoverview The exporter service — compiles submitted eval records to a
 * downstream format: jsonl (lossless, one record per line), csv (flattened,
 * lossy summary), inspect (UK AISI Inspect AI task/sample), and lm-eval
 * (EleutherAI lm-evaluation-harness manifest). Maps the grader DSL to each
 * harness's scoring primitive where one exists, else emits the grader spec
 * inline so nothing is silently dropped.
 * @module services/exporter/exporter-service
 */

import type { EvalRecord, Grader } from '@/services/eval-record/schema.js';

export type ExportFormat = 'jsonl' | 'csv' | 'inspect' | 'lm-eval';

/** File extension per export format. */
export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  jsonl: 'jsonl',
  csv: 'csv',
  inspect: 'json',
  'lm-eval': 'json',
};

/** Escape a value for a CSV cell (RFC 4180 quoting). */
function csvCell(value: unknown): string {
  const s =
    value === undefined || value === null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Map the grader DSL to Inspect AI's scorer name, with the spec carried inline. */
function inspectScorer(grader: Grader): { scorer: string; spec: Grader } {
  const scorer =
    grader.kind === 'numeric'
      ? 'match_numeric'
      : grader.kind === 'exact_match'
        ? 'match'
        : grader.kind === 'mcq'
          ? 'choice'
          : grader.kind === 'regex'
            ? 'pattern'
            : grader.kind === 'set_match'
              ? 'includes'
              : grader.kind === 'json_match'
                ? 'json'
                : 'model_graded_qa'; // llm_rubric
  return { scorer, spec: grader };
}

/** Map the grader DSL to lm-eval's output_type/metric, with the spec carried inline. */
function lmEvalMetric(grader: Grader): { output_type: string; metric: string; spec: Grader } {
  if (grader.kind === 'mcq') return { output_type: 'multiple_choice', metric: 'acc', spec: grader };
  if (grader.kind === 'llm_rubric')
    return { output_type: 'generate_until', metric: 'llm_judge', spec: grader };
  return { output_type: 'generate_until', metric: 'exact_match', spec: grader };
}

export class ExporterService {
  /** Compile records to the requested format, returning the artifact text and a short preview. */
  compile(records: EvalRecord[], format: ExportFormat): { content: string; preview: string } {
    const content =
      format === 'jsonl'
        ? this.toJsonl(records)
        : format === 'csv'
          ? this.toCsv(records)
          : format === 'inspect'
            ? this.toInspect(records)
            : this.toLmEval(records);
    const preview = content.split('\n').slice(0, 20).join('\n');
    return { content, preview };
  }

  private toJsonl(records: EvalRecord[]): string {
    return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  }

  private toCsv(records: EvalRecord[]): string {
    const header = ['id', 'task_type', 'prompt', 'gold', 'grader.kind', 'domain', 'tags', 'status'];
    const rows = records.map((r) =>
      [
        r.id,
        r.task_type,
        r.prompt,
        r.gold,
        r.grader.kind,
        r.metadata.domain,
        r.metadata.tags.join('|'),
        r.status,
      ]
        .map(csvCell)
        .join(','),
    );
    return `${[header.join(','), ...rows].join('\n')}\n`;
  }

  private toInspect(records: EvalRecord[]): string {
    const samples = records.map((r) => {
      const { scorer, spec } = inspectScorer(r.grader);
      return {
        id: r.id,
        input: r.prompt,
        target: r.gold,
        ...(r.context ? { context: r.context } : {}),
        ...(r.choices ? { choices: r.choices } : {}),
        scorer,
        grader_spec: spec,
        metadata: { domain: r.metadata.domain, tags: r.metadata.tags, task_type: r.task_type },
      };
    });
    return `${JSON.stringify({ version: 1, format: 'inspect', samples }, null, 2)}\n`;
  }

  private toLmEval(records: EvalRecord[]): string {
    const docs = records.map((r) => {
      const { output_type, metric, spec } = lmEvalMetric(r.grader);
      return {
        doc_id: r.id,
        query: r.prompt,
        gold: r.gold,
        ...(r.choices ? { choices: r.choices } : {}),
        output_type,
        metric,
        grader_spec: spec,
        metadata: { domain: r.metadata.domain, tags: r.metadata.tags, task_type: r.task_type },
      };
    });
    return `${JSON.stringify({ version: 1, format: 'lm-eval', docs }, null, 2)}\n`;
  }
}

// --- Init/accessor pattern ---

let _service: ExporterService | undefined;

export function initExporterService(): ExporterService {
  _service = new ExporterService();
  return _service;
}

export function getExporterService(): ExporterService {
  if (!_service) {
    throw new Error('ExporterService not initialized — call initExporterService() in setup()');
  }
  return _service;
}
