/**
 * @fileoverview Tests for evals_create_draft — validation rejections from the
 * builder (grader_unexecutable, task_type_constraint for mcq/free_response,
 * mcq_choice_mismatch), draft-time verification seeding, captures stored
 * unresolved, the default-license application, and format() completeness (the
 * parrot-back must render the gold + grader + subagent prompt). Uses a real
 * temp-dir store singleton.
 * @module tests/tools/create-draft.tool.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { getRecordTool } from '@/mcp-server/tools/definitions/get-record.tool.js';
import type { EvalRecord } from '@/services/eval-record/schema.js';
import { initRecordStoreService } from '@/services/record-store/record-store-service.js';

let dataDir: string;
const ctx = createMockContext();
const createCtx = createMockContext({ errors: createDraftTool.errors });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'evals-create-'));
  process.env.EVALS_DATA_DIR = dataDir;
  process.env.EVALS_DEFAULT_LICENSE = 'CC-BY-4.0';
  delete process.env.EVALS_CAPTURE_DIR;
  resetServerConfig();
  await initRecordStoreService(dataDir, undefined).init();
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  resetServerConfig();
});

describe('evals_create_draft — happy path and seeding', () => {
  it('persists a draft, applies the default license, and reports self-consistency', async () => {
    const result = await createDraftTool.handler(
      createDraftTool.input.parse({
        task_type: 'numeric',
        prompt: 'P(both red)?',
        gold: '5/14',
        grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
        discrimination: { positive: ['10/28'], negative: ['25/64'] },
        metadata: { domain: 'math.probability', tags: ['combinatorics'] },
      }),
      createCtx,
    );
    expect(result.status).toBe('draft');
    expect(result.draft_id).toMatch(/^ev_/);
    expect(result.server_checks.self_consistency.grader_ok).toBe(true);
    expect(result.server_checks.self_consistency.verification_present).toBe(false);
    expect((result.normalized_record as EvalRecord).metadata.license).toBe('CC-BY-4.0');
    // author_model falls back to "unknown" when omitted.
    expect((result.normalized_record as EvalRecord).provenance.author_model).toBe('unknown');
  });

  it('seeds draft-time verification so verification_present is true on create', async () => {
    const result = await createDraftTool.handler(
      createDraftTool.input.parse({
        task_type: 'numeric',
        prompt: 'Seeded verification — P(both red)?',
        gold: '5/14',
        grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
        discrimination: { positive: ['10/28'], negative: ['25/64'] },
        metadata: { domain: 'math.probability', tags: ['seeded'] },
        verification: {
          method: 'independent_derivation',
          generation_method: 'closed_form',
          evidence: [{ type: 'note', text: 'Confirmed by hand.' }],
        },
      }),
      createCtx,
    );
    expect(result.server_checks.self_consistency.verification_present).toBe(true);
    expect(result.server_checks.self_consistency.ready_to_submit).toBe(true);
  });

  it('stores captures ids on the draft even when capture resolution is inactive', async () => {
    const result = await createDraftTool.handler(
      createDraftTool.input.parse({
        task_type: 'numeric',
        prompt: 'Captured gold — P(both red)?',
        gold: '5/14',
        grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
        discrimination: { positive: ['10/28'], negative: ['25/64'] },
        metadata: { domain: 'math.probability', tags: ['capture'] },
        captures: ['secedgar_a1b2c3d4'],
      }),
      createCtx,
    );
    const fetched = await getRecordTool.handler(
      getRecordTool.input.parse({ id: result.draft_id }),
      ctx,
    );
    expect((fetched.record as EvalRecord).captures).toEqual(['secedgar_a1b2c3d4']);
  });
});

describe('evals_create_draft — validation rejections', () => {
  it('throws grader_unexecutable for a malformed math.js target', async () => {
    await expect(
      createDraftTool.handler(
        createDraftTool.input.parse({
          task_type: 'numeric',
          prompt: 'bad target',
          gold: '1',
          grader: { kind: 'numeric', target: '5/' },
          discrimination: { positive: [], negative: ['0'] },
          metadata: { domain: 'd', tags: [] },
        }),
        createCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'grader_unexecutable' } });
  });

  it('throws task_type_constraint for mcq without choices', async () => {
    await expect(
      createDraftTool.handler(
        createDraftTool.input.parse({
          task_type: 'mcq',
          prompt: 'pick one',
          gold: 'B',
          grader: { kind: 'mcq', correct: 'B' },
          discrimination: { positive: ['B'], negative: ['A'] },
          metadata: { domain: 'd', tags: [] },
        }),
        createCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'task_type_constraint' } });
  });

  it('throws task_type_constraint when mcq grader.correct is not among choices', async () => {
    await expect(
      createDraftTool.handler(
        createDraftTool.input.parse({
          task_type: 'mcq',
          prompt: 'pick one',
          gold: 'Z',
          grader: { kind: 'mcq', correct: 'Z' },
          choices: ['A', 'B', 'C'],
          discrimination: { positive: ['Z'], negative: ['A'] },
          metadata: { domain: 'd', tags: [] },
        }),
        createCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'task_type_constraint' } });
  });

  it('throws task_type_constraint for free_response without an llm_rubric grader', async () => {
    await expect(
      createDraftTool.handler(
        createDraftTool.input.parse({
          task_type: 'free_response',
          prompt: 'write an essay',
          gold: 'a good essay',
          grader: { kind: 'exact_match' },
          discrimination: { positive: [], negative: ['bad'] },
          metadata: { domain: 'd', tags: [] },
        }),
        createCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'task_type_constraint' } });
  });

  it('rejects an empty prompt at the Zod boundary (min 1)', () => {
    expect(() =>
      createDraftTool.input.parse({
        task_type: 'numeric',
        prompt: '',
        gold: '1',
        grader: { kind: 'numeric', target: '1' },
        discrimination: { positive: [], negative: ['0'] },
        metadata: { domain: 'd', tags: [] },
      }),
    ).toThrow();
  });

  it('rejects an unknown task_type at the Zod boundary', () => {
    expect(() =>
      createDraftTool.input.parse({
        task_type: 'not_a_type',
        prompt: 'x',
        gold: '1',
        grader: { kind: 'numeric', target: '1' },
        discrimination: { positive: [], negative: ['0'] },
        metadata: { domain: 'd', tags: [] },
      }),
    ).toThrow();
  });

  it('rejects a grader with an unknown kind at the Zod boundary (discriminated union)', () => {
    expect(() =>
      createDraftTool.input.parse({
        task_type: 'numeric',
        prompt: 'x',
        gold: '1',
        grader: { kind: 'totally_made_up' },
        discrimination: { positive: [], negative: ['0'] },
        metadata: { domain: 'd', tags: [] },
      }),
    ).toThrow();
  });
});

describe('evals_create_draft — format()', () => {
  it('parrots the gold, grader, and subagent prompt into the content[] text', async () => {
    const result = await createDraftTool.handler(
      createDraftTool.input.parse({
        task_type: 'numeric',
        prompt: 'Formatted — P(both red)?',
        gold: '5/14',
        grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
        discrimination: { positive: ['10/28'], negative: ['25/64'] },
        metadata: { domain: 'math.probability', tags: ['fmt'] },
      }),
      createCtx,
    );
    const blocks = createDraftTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    expect(text).toContain(result.draft_id);
    expect(text).toContain('5/14');
    expect(text).toContain('numeric, target=');
    // The ready-to-paste subagent prompt is embedded.
    expect(text).toContain('evals_get_record');
  });
});
