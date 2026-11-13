/**
 * @fileoverview Tests for evals_revise_draft — the mcq_choice_mismatch path
 * (the primary coverage gap) and format() output. The record_frozen guard,
 * invalid_patch_path, and numeric happy-path are already covered in
 * tests/authoring-loop.test.ts.
 * @module tests/tools/revise-draft.tool.test
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { reviseDraftTool } from '@/mcp-server/tools/definitions/revise-draft.tool.js';
import { initRecordStoreService } from '@/services/record-store/record-store-service.js';

let dataDir: string;
const createCtx = createMockContext({ errors: createDraftTool.errors });
const reviseCtx = createMockContext({ errors: reviseDraftTool.errors });

/** Create a valid MCQ draft and return its id. */
async function createMcqDraft(): Promise<string> {
  const result = await createDraftTool.handler(
    createDraftTool.input.parse({
      task_type: 'mcq',
      prompt: 'Which of the following is a prime number?',
      gold: 'B',
      grader: { kind: 'mcq', correct: 'B' },
      choices: ['A', 'B', 'C'],
      discrimination: { positive: ['B'], negative: ['A'] },
      metadata: { domain: 'math.primes', tags: ['mcq'] },
    }),
    createCtx,
  );
  return result.draft_id;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'evals-revise-'));
  process.env.EVALS_DATA_DIR = dataDir;
  delete process.env.EVALS_CAPTURE_DIR;
  resetServerConfig();
  await initRecordStoreService(dataDir, undefined).init();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  resetServerConfig();
});

describe('evals_revise_draft — mcq_choice_mismatch', () => {
  it.each([
    { set: { captured_outputs: [] } },
    { append: { captured_outputs: [] } },
    { set: { 'captured_outputs.0.args': {} } },
    { append: { 'captured_outputs.0.args.list': [] } },
    { unset: ['captured_outputs'] },
    { unset: ['captured_outputs.0.args.list'] },
  ])('rejects the server-owned capture subtree atomically: %j', async (ops) => {
    const draftId = await createMcqDraft();
    const file = join(dataDir, 'drafts', `${draftId}.json`);
    const before = await readFile(file, 'utf8');
    const result = await runToolContract(reviseDraftTool, {
      ...ops,
      draft_id: draftId,
      set: { 'metadata.domain': 'changed', ...ops.set },
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        message: expect.stringContaining('server-owned field'),
        data: { reason: 'invalid_patch_path', recovery: { hint: expect.any(String) } },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('invalid_patch_path') }),
      ]),
    );
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it.each([
    { kind: 'numeric', target: '5/' },
    { kind: 'regex', pattern: '(' },
    { kind: 'json_match' },
    { kind: 'json_match', schema: { type: 'invalid' } },
  ])('preserves draft bytes when revised grader cannot execute: %j', async (grader) => {
    const draftId = await createMcqDraft();
    const file = join(dataDir, 'drafts', `${draftId}.json`);
    const before = await readFile(file, 'utf8');
    await expect(
      reviseDraftTool.handler(
        reviseDraftTool.input.parse({ draft_id: draftId, set: { grader } }),
        reviseCtx,
      ),
    ).rejects.toMatchObject({ code: -32007, data: { reason: 'grader_unexecutable' } });
    const result = await runToolContract(reviseDraftTool, { draft_id: draftId, set: { grader } });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'grader_unexecutable', recovery: { hint: expect.any(String) } },
      },
    });
    expect(
      result.content.some((block) => block.type === 'text' && block.text.includes('Recovery:')),
    ).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it('throws mcq_choice_mismatch when grader.correct is patched to a value not in choices', async () => {
    const draftId = await createMcqDraft();
    await expect(
      reviseDraftTool.handler(
        reviseDraftTool.input.parse({
          draft_id: draftId,
          set: { 'grader.correct': 'Z' },
        }),
        reviseCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'mcq_choice_mismatch' } });
  });

  it('throws mcq_choice_mismatch when choices is patched to exclude the current correct answer', async () => {
    const draftId = await createMcqDraft();
    await expect(
      reviseDraftTool.handler(
        reviseDraftTool.input.parse({
          draft_id: draftId,
          set: { choices: ['X', 'Y', 'Z'] },
        }),
        reviseCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'mcq_choice_mismatch' } });
  });
});

describe('evals_revise_draft — happy path (mcq)', () => {
  it('reports failed verification in readiness while preserving skipped rubric verdicts', async () => {
    const draft = await createDraftTool.handler(
      createDraftTool.input.parse({
        task_type: 'free_response',
        prompt: 'Explain the sky.',
        gold: 'Scattering.',
        grader: {
          kind: 'llm_rubric',
          criteria: [{ description: 'Names scattering' }],
          judge_prompt: 'Grade the explanation.',
          pass_threshold: 0.5,
        },
        discrimination: { positive: ['Light scatters.'], negative: ['Ocean reflection.'] },
        metadata: { domain: 'physics', tags: [] },
        verification: { method: 'note', evidence: [{ type: 'note', text: 'Confirmed.' }] },
      }),
      createCtx,
    );
    expect(draft.server_checks.self_consistency.ready_to_submit).toBe(true);
    const revised = await runToolContract(reviseDraftTool, {
      draft_id: draft.draft_id,
      append: {
        'verification.evidence': [
          { type: 'deterministic_check', tool: 'verifier', claim: 'gold', passed: false },
        ],
      },
    });
    expect(revised.structuredContent).toMatchObject({
      server_checks: {
        self_consistency: {
          positives_pass: [false],
          negatives_rejected: [false],
          verification_present: true,
          ready_to_submit: false,
        },
      },
    });
    expect(revised.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('not graded (llm_rubric)') }),
    ]);
  });

  it('rejects an out-of-range rubric revision without changing the draft', async () => {
    const draftId = await createMcqDraft();
    const file = join(dataDir, 'drafts', `${draftId}.json`);
    const before = await readFile(file, 'utf8');
    const result = await runToolContract(reviseDraftTool, {
      draft_id: draftId,
      set: {
        grader: {
          kind: 'llm_rubric',
          criteria: [{ description: 'Names scattering' }],
          judge_prompt: 'Grade it.',
          pass_threshold: 7,
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('pass_threshold') }),
    ]);
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it('rejects a mixed unknown-path patch without writing', async () => {
    const draftId = await createMcqDraft();
    const file = join(dataDir, 'drafts', `${draftId}.json`);
    const before = await readFile(file, 'utf8');
    await expect(
      reviseDraftTool.handler(
        reviseDraftTool.input.parse({
          draft_id: draftId,
          set: { 'metadata.domain': 'updated', 'not.real': true },
        }),
        reviseCtx,
      ),
    ).rejects.toMatchObject({ code: -32007, data: { reason: 'invalid_patch_path' } });
    const result = await runToolContract(reviseDraftTool, {
      draft_id: draftId,
      set: { 'metadata.domain': 'updated', 'not.real': true },
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'invalid_patch_path', recovery: { hint: expect.any(String) } },
      },
    });
    expect(
      result.content.some((block) => block.type === 'text' && block.text.includes('Recovery:')),
    ).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it('accepts a valid grader.correct patch and reports the change', async () => {
    const draftId = await createMcqDraft();
    const result = await reviseDraftTool.handler(
      reviseDraftTool.input.parse({
        draft_id: draftId,
        set: { 'grader.correct': 'C', gold: 'C' },
      }),
      reviseCtx,
    );
    expect(result.changed.some((c) => c.path === 'grader.correct' && c.after === 'C')).toBe(true);
    expect(result.server_checks.self_consistency.grader_ok).toBeDefined();
  });
});

describe('evals_revise_draft — format()', () => {
  it('renders changed paths and self-consistency into content[]', async () => {
    const draftId = await createMcqDraft();
    const result = await reviseDraftTool.handler(
      reviseDraftTool.input.parse({
        draft_id: draftId,
        set: { 'metadata.domain': 'math.updated' },
      }),
      reviseCtx,
    );
    const blocks = reviseDraftTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    expect(text).toContain(draftId);
    expect(text).toContain('metadata.domain');
    expect(text).toContain('self-consistency');
  });
});
