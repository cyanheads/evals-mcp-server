/**
 * @fileoverview Unit tests for the exporter service — JSONL is lossless, CSV is a
 * flattened summary, and Inspect/lm-eval carry the grader spec inline.
 * @module tests/services/exporter.test
 */

import { describe, expect, it } from 'vitest';
import type { EvalRecord } from '@/services/eval-record/schema.js';
import { ExporterService } from '@/services/exporter/exporter-service.js';

const record: EvalRecord = {
  id: 'ev_test000001',
  status: 'submitted',
  task_type: 'numeric',
  prompt: 'P(both red)?',
  gold: '5/14',
  grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
  discrimination: { positive: ['10/28'], negative: ['25/64'] },
  metadata: { domain: 'math.probability', tags: ['combinatorics'] },
  verification: { method: 'independent_derivation', evidence: [{ type: 'note', text: 'ok' }] },
  provenance: { author_model: 'claude-opus-4-8', created_at: '2026-06-23T00:00:00.000Z' },
  content_hash: 'sha256:abc',
  submitted_at: '2026-06-23T00:01:00.000Z',
  checksum: 'sha256:def',
};

const exporter = new ExporterService();

describe('ExporterService', () => {
  it('jsonl round-trips a record losslessly', () => {
    const { content } = exporter.compile([record], 'jsonl');
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(record);
  });

  it('csv emits a flattened summary with a header row', () => {
    const { content } = exporter.compile([record], 'csv');
    const [header, row] = content.trim().split('\n');
    expect(header).toBe('id,task_type,prompt,gold,grader.kind,domain,tags,status');
    expect(row).toContain('ev_test000001');
    expect(row).toContain('numeric');
  });

  it('inspect carries the grader spec inline alongside a scorer name', () => {
    const { content } = exporter.compile([record], 'inspect');
    const parsed = JSON.parse(content);
    expect(parsed.format).toBe('inspect');
    expect(parsed.samples[0].scorer).toBe('match_numeric');
    expect(parsed.samples[0].grader_spec.kind).toBe('numeric');
    expect(parsed.samples[0].target).toBe('5/14');
  });

  it('lm-eval carries output_type/metric and the grader spec', () => {
    const { content } = exporter.compile([record], 'lm-eval');
    const parsed = JSON.parse(content);
    expect(parsed.format).toBe('lm-eval');
    expect(parsed.docs[0].grader_spec.kind).toBe('numeric');
    expect(parsed.docs[0].query).toBe('P(both red)?');
  });

  it('produces an empty-but-valid artifact for zero records', () => {
    const { content } = exporter.compile([], 'jsonl');
    expect(content.trim()).toBe('');
  });
});
