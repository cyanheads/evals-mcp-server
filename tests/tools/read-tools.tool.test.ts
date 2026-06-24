/**
 * @fileoverview Tests for the read-only / stateless tools that lacked dedicated
 * coverage: evals_describe_schema (per-task-type guidance + notes + format),
 * evals_run_check (multi-candidate, gold no-op for target-embedding kinds, the
 * grader_unexecutable and mcq_choice_mismatch ctx.fail contracts, format), and
 * evals_get_record's format() rendering. describe-schema and run-check need no
 * store; get-record uses a temp-dir store singleton.
 * @module tests/tools/read-tools.tool.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { describeSchemaTool } from '@/mcp-server/tools/definitions/describe-schema.tool.js';
import { getRecordTool } from '@/mcp-server/tools/definitions/get-record.tool.js';
import { runCheckTool } from '@/mcp-server/tools/definitions/run-check.tool.js';
import { type EvalRecord, TASK_TYPES } from '@/services/eval-record/schema.js';
import { initRecordStoreService } from '@/services/record-store/record-store-service.js';

const ctx = createMockContext();
const runCheckCtx = createMockContext({ errors: runCheckTool.errors });

describe('evals_describe_schema', () => {
  it('returns required fields, gold shape, and grader kinds for every task type', async () => {
    for (const tt of TASK_TYPES) {
      const result = await describeSchemaTool.handler(
        describeSchemaTool.input.parse({ task_type: tt }),
        ctx,
      );
      expect(result.task_type).toBe(tt);
      expect(result.required_fields).toContain('task_type');
      expect(result.grader_kinds.length).toBeGreaterThan(0);
      expect(result.gold_shape.length).toBeGreaterThan(0);
    }
  });

  it('adds the choices requirement and choice note for mcq', async () => {
    const result = await describeSchemaTool.handler(
      describeSchemaTool.input.parse({ task_type: 'mcq' }),
      ctx,
    );
    expect(result.required_fields.some((f) => f.includes('choices'))).toBe(true);
    expect(result.notes).toContain('choices');
  });

  it('adds the llm_rubric requirement and sampling note for free_response', async () => {
    const result = await describeSchemaTool.handler(
      describeSchemaTool.input.parse({ task_type: 'free_response' }),
      ctx,
    );
    expect(result.required_fields.some((f) => f.includes('llm_rubric'))).toBe(true);
    expect(result.grader_kinds).toContain('llm_rubric');
    expect(result.notes).toContain('ctx.sample');
  });

  it('format() renders the task type, gold shape, and required fields', async () => {
    const result = await describeSchemaTool.handler(
      describeSchemaTool.input.parse({ task_type: 'numeric' }),
      ctx,
    );
    const text = (describeSchemaTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('## numeric');
    expect(text).toContain('Gold shape');
    expect(text).toContain('Required fields');
  });
});

describe('evals_run_check', () => {
  it('grades multiple candidates and reports the pass_count + resolved reference', () => {
    const result = runCheckTool.handler(
      runCheckTool.input.parse({
        grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
        candidates: ['5/14', '10/28', '25/64'],
      }),
      runCheckCtx,
    );
    expect(result.pass_count).toBe(2);
    expect(result.results.map((r) => r.pass)).toEqual([true, true, false]);
    expect(result.results[0].resolved).toBeCloseTo(0.3571428, 6);
  });

  it('uses gold for exact_match and ignores it for target-embedding kinds', () => {
    // gold supplies the reference for exact_match.
    const exact = runCheckTool.handler(
      runCheckTool.input.parse({
        grader: { kind: 'exact_match', normalize: ['trim', 'lowercase'] },
        candidates: ['  PARIS '],
        gold: 'paris',
      }),
      runCheckCtx,
    );
    expect(exact.results[0].pass).toBe(true);

    // gold is a no-op (not an error) for numeric.
    const numeric = runCheckTool.handler(
      runCheckTool.input.parse({
        grader: { kind: 'numeric', target: '5/14' },
        candidates: ['5/14'],
        gold: 'this is ignored',
      }),
      runCheckCtx,
    );
    expect(numeric.results[0].pass).toBe(true);
  });

  it('throws grader_unexecutable for a malformed math.js target', async () => {
    await expect(
      Promise.resolve().then(() =>
        runCheckTool.handler(
          runCheckTool.input.parse({
            grader: { kind: 'numeric', target: 'log(' },
            candidates: ['1'],
          }),
          runCheckCtx,
        ),
      ),
    ).rejects.toMatchObject({ data: { reason: 'grader_unexecutable' } });
  });

  it('throws grader_unexecutable when given an llm_rubric grader', async () => {
    await expect(
      Promise.resolve().then(() =>
        runCheckTool.handler(
          runCheckTool.input.parse({
            grader: {
              kind: 'llm_rubric',
              criteria: [{ description: 'x' }],
              judge_prompt: 'j',
              pass_threshold: 0.5,
            },
            candidates: ['answer'],
          }),
          runCheckCtx,
        ),
      ),
    ).rejects.toMatchObject({ data: { reason: 'grader_unexecutable' } });
  });

  it('throws mcq_choice_mismatch when correct is not among the supplied choices', async () => {
    await expect(
      Promise.resolve().then(() =>
        runCheckTool.handler(
          runCheckTool.input.parse({
            grader: { kind: 'mcq', correct: 'Z' },
            candidates: ['Z'],
            choices: ['A', 'B'],
          }),
          runCheckCtx,
        ),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mcq_choice_mismatch' } });
  });

  it('rejects an empty candidates array at the Zod boundary (min 1)', () => {
    expect(() =>
      runCheckTool.input.parse({ grader: { kind: 'numeric', target: '1' }, candidates: [] }),
    ).toThrow();
  });

  it('format() renders PASS/REJECT per candidate and the count line', () => {
    const result = runCheckTool.handler(
      runCheckTool.input.parse({
        grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
        candidates: ['5/14', '25/64'],
      }),
      runCheckCtx,
    );
    const text = (runCheckTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('PASS');
    expect(text).toContain('REJECT');
    expect(text).toContain('1/2 passed');
  });
});

describe('evals_get_record', () => {
  let dataDir: string;
  let recordId: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'evals-get-'));
    process.env.EVALS_DATA_DIR = dataDir;
    delete process.env.EVALS_DEFAULT_LICENSE;
    delete process.env.EVALS_CAPTURE_DIR;
    resetServerConfig();
    await initRecordStoreService(dataDir, undefined).init();
    const created = await createDraftTool.handler(
      createDraftTool.input.parse({
        task_type: 'numeric',
        prompt: 'Get me — P(both red)?',
        gold: '5/14',
        grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
        discrimination: { positive: ['10/28'], negative: ['25/64'] },
        metadata: { domain: 'math.probability', tags: [] },
      }),
      createMockContext({ errors: createDraftTool.errors }),
    );
    recordId = created.draft_id;
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    resetServerConfig();
  });

  it('throws not_found for an unknown id', async () => {
    await expect(
      getRecordTool.handler(
        getRecordTool.input.parse({ id: 'ev_doesnotexist' }),
        createMockContext({ errors: getRecordTool.errors }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });

  it('format() renders the id, status, prompt, gold, and the full JSON block', async () => {
    const result = await getRecordTool.handler(getRecordTool.input.parse({ id: recordId }), ctx);
    const text = (getRecordTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain(recordId);
    expect(text).toContain('(draft)');
    expect(text).toContain('**gold:** 5/14');
    expect(text).toContain('```json');
    // The JSON block round-trips to the stored record.
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect((JSON.parse(json) as EvalRecord).id).toBe(recordId);
  });
});
