/**
 * @fileoverview The exporter service — compiles submitted eval records to a
 * downstream format: jsonl (lossless, one record per line), csv (flattened,
 * lossy summary), inspect (UK AISI Inspect AI task/sample), and lm-eval
 * (EleutherAI lm-evaluation-harness data manifest). Scoring hints suggest
 * downstream adapters; grader_spec retains the actual grading contract.
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

/** Suggest a real Inspect scorer where one fits; options do not replace grader_spec. */
function inspectScorer(grader: Grader) {
  switch (grader.kind) {
    case 'numeric':
      return { scorer: 'match', scorer_args: { numeric: true } };
    case 'exact_match':
      return {
        scorer: 'match',
        scorer_args: {
          location: 'exact',
          ignore_case: grader.normalize?.includes('lowercase') ?? false,
        },
      };
    case 'mcq':
      return { scorer: 'choice' };
    case 'regex':
      return {
        scorer: 'pattern',
        scorer_args: { pattern: grader.pattern, ignore_case: grader.flags?.includes('i') ?? false },
      };
    case 'llm_rubric':
      return { scorer: 'model_graded_qa' };
    case 'set_match':
    case 'json_match':
      return {};
  }
}

/** Suggest lm-eval's output type and a compatible built-in metric, if available. */
function lmEvalMetric(grader: Grader) {
  if (grader.kind === 'mcq') return { output_type: 'multiple_choice', metric: 'acc' };
  if (grader.kind === 'exact_match')
    return { output_type: 'generate_until', metric: 'exact_match' };
  return { output_type: 'generate_until' };
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
      const choiceIndex =
        r.grader.kind === 'mcq' ? r.choices?.indexOf(r.grader.correct) : undefined;
      const target =
        choiceIndex !== undefined && choiceIndex >= 0
          ? choiceIndex < 26
            ? String.fromCharCode(65 + choiceIndex)
            : String(choiceIndex - 25)
          : typeof r.gold === 'string'
            ? r.gold
            : JSON.stringify(r.gold);
      return {
        id: r.id,
        input: r.context ? `${r.context}\n\n${r.prompt}` : r.prompt,
        target,
        ...(r.choices ? { choices: r.choices } : {}),
        ...(r.grader.kind === 'mcq' && choiceIndex === undefined ? {} : inspectScorer(r.grader)),
        grader_spec: r.grader,
        metadata: { domain: r.metadata.domain, tags: r.metadata.tags, task_type: r.task_type },
      };
    });
    return `${JSON.stringify(samples, null, 2)}\n`;
  }

  private toLmEval(records: EvalRecord[]): string {
    const docs = records.map((r) => ({
      doc_id: r.id,
      query: r.prompt,
      gold: r.gold,
      ...(r.context !== undefined ? { context: r.context } : {}),
      ...(r.choices ? { choices: r.choices } : {}),
      ...lmEvalMetric(r.grader),
      grader_spec: r.grader,
      metadata: { domain: r.metadata.domain, tags: r.metadata.tags, task_type: r.task_type },
    }));
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
