/**
 * @fileoverview Tests for evals_revise_draft — the mcq_choice_mismatch path
 * (the primary coverage gap) and format() output. The record_frozen guard,
 * invalid_patch_path, and numeric happy-path are already covered in
 * tests/authoring-loop.test.ts.
 * @module tests/tools/revise-draft.tool.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { reviseDraftTool } from '@/mcp-server/tools/definitions/revise-draft.tool.js';
import { initRecordStoreService } from '@/services/record-store/record-store-service.js';

let dataDir: string;
const ctx = createMockContext();
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
    ctx,
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
