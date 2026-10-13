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
