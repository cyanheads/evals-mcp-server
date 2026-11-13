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
  it.each([
    [25, 'Z'],
    [26, '1'],
    [27, '2'],
  ] as const)('uses Inspect choice labels for zero-based index %s', (index, target) => {
    const choices = Array.from({ length: 28 }, (_, i) => `Choice ${i + 1}`);
    const sample = {
      ...record,
      task_type: 'mcq' as const,
      gold: choices[index],
      choices,
      grader: { kind: 'mcq' as const, correct: choices[index]! },
    };
    expect(JSON.parse(exporter.compile([sample], 'inspect').content)[0].target).toBe(target);
  });

  it('exports Inspect samples directly with context and a choice-letter target', () => {
    const mcq: EvalRecord = {
      ...record,
      task_type: 'mcq',
      context: 'Mars is called the red planet.',
      prompt: 'Which planet is red?',
      gold: 'Mars',
      choices: ['Venus', 'Mars', 'Jupiter', 'Earth'],
      grader: { kind: 'mcq', correct: 'Mars' },
    };
    const samples = JSON.parse(exporter.compile([mcq], 'inspect').content);
    expect(samples).toEqual([
      expect.objectContaining({
        id: record.id,
        input: 'Mars is called the red planet.\n\nWhich planet is red?',
        target: 'B',
        choices: ['Venus', 'Mars', 'Jupiter', 'Earth'],
        grader_spec: { kind: 'mcq', correct: 'Mars' },
      }),
    ]);
  });

  it('keeps structured gold readable as a single Inspect target', () => {
    const records: EvalRecord[] = [
      { ...record, gold: 391 },
      {
        ...record,
        task_type: 'json_answer',
        gold: { answer: 42 },
        grader: { kind: 'json_match', expected: { answer: 42 } },
      },
      {
        ...record,
        task_type: 'set_answer',
        gold: ['red', 'blue'],
        grader: { kind: 'set_match', expected: ['red', 'blue'] },
      },
      {
        ...record,
        task_type: 'json_answer',
        gold: true,
        grader: { kind: 'json_match', expected: true },
      },
      {
        ...record,
        task_type: 'json_answer',
        gold: null,
        grader: { kind: 'json_match', expected: null },
      },
    ];
    const samples = JSON.parse(exporter.compile(records, 'inspect').content);
    expect(samples.map((sample: { target: string }) => sample.target)).toEqual([
      '391',
      '{"answer":42}',
      '["red","blue"]',
      'true',
      'null',
    ]);
    expect(exporter.compile([], 'inspect').content).toBe('[]\n');
  });

  it('exports an existing numeric scorer with its required options', () => {
    const samples = JSON.parse(exporter.compile([record], 'inspect').content);
    expect(samples[0]).toMatchObject({ scorer: 'match', scorer_args: { numeric: true } });
  });

  it('omits unsupported scorer and metric hints while retaining the grader', () => {
    const json: EvalRecord = {
      ...record,
      task_type: 'json_answer',
      gold: { answer: 42 },
      grader: { kind: 'json_match', expected: { answer: 42 } },
    };
    const set: EvalRecord = {
      ...record,
      task_type: 'set_answer',
      gold: ['red', 'blue'],
      grader: { kind: 'set_match', expected: ['red', 'blue'] },
    };
    const rubric: EvalRecord = {
      ...record,
      task_type: 'free_response',
      gold: 'Mars is red.',
      grader: {
        kind: 'llm_rubric',
        criteria: [{ description: 'Correct fact' }],
        judge_prompt: 'Judge the fact.',
        pass_threshold: 0.5,
      },
    };
    const samples = JSON.parse(exporter.compile([json, set], 'inspect').content);
    expect(samples).toHaveLength(2);
    for (const sample of samples) {
      expect(sample).not.toHaveProperty('scorer');
      expect(sample).toHaveProperty('grader_spec');
    }
    const docs = JSON.parse(exporter.compile([rubric], 'lm-eval').content).docs;
    expect(docs[0]).not.toHaveProperty('metric');
    expect(docs[0].grader_spec).toEqual(rubric.grader);
  });

  it('preserves context and choice text in lm-eval documents', () => {
    const mcq: EvalRecord = {
      ...record,
      task_type: 'mcq',
      context: 'Mars is red.',
      gold: 'Mars',
      choices: ['Venus', 'Mars'],
      grader: { kind: 'mcq', correct: 'Mars' },
    };
    const artifact = JSON.parse(exporter.compile([mcq], 'lm-eval').content);
    expect(artifact).toMatchObject({
      version: 1,
      format: 'lm-eval',
      docs: [
        {
          context: 'Mars is red.',
          gold: 'Mars',
          choices: ['Venus', 'Mars'],
          output_type: 'multiple_choice',
          metric: 'acc',
        },
      ],
    });
  });

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
    expect(parsed).toHaveLength(1);
    expect(parsed[0].scorer).toBe('match');
    expect(parsed[0].grader_spec.kind).toBe('numeric');
    expect(parsed[0].target).toBe('5/14');
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
