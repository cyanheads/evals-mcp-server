/**
 * @fileoverview Tests for evals_submit_draft's capture-resolution path (the
 * EVALS_CAPTURE_DIR feature). Covers the missing-file refusal (capture_unresolved),
 * the failed-capture refusal, the captured-gold cross-check disagreement
 * (verification_disagrees_with_gold), and the success case where a captured value
 * agrees with the gold, embeds the dump into captured_outputs, and lifts a source
 * citation into metadata.source_provenance. Uses a real temp store + capture dir.
 * @module tests/tools/submit-captures.tool.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { getRecordTool } from '@/mcp-server/tools/definitions/get-record.tool.js';
import { submitDraftTool } from '@/mcp-server/tools/definitions/submit-draft.tool.js';
import type { Capture, EvalRecord } from '@/services/eval-record/schema.js';
import { initRecordStoreService } from '@/services/record-store/record-store-service.js';

let dataDir: string;
let captureDir: string;
const ctx = createMockContext();
const createCtx = createMockContext({ errors: createDraftTool.errors });
const submitCtx = createMockContext({ errors: submitDraftTool.errors });

/** Write a capture dump file the store can resolve. */
async function writeCapture(
  id: string,
  capture: Partial<Capture> & { structuredContent: unknown },
) {
  const full: Capture = {
    evals_id: id,
    ts: '2026-06-23T00:00:00.000Z',
    server: 'secedgar',
    serverVersion: '1.0.0',
    tool: 'secedgar_get_financials',
    args: { ticker: 'AAPL', concept: 'revenue' },
    isError: false,
    ...capture,
  } as Capture;
  await writeFile(join(captureDir, `${id}.json`), JSON.stringify(full), 'utf8');
}

/** Create a capture-backed draft whose gold is a numeric value, with verification seeded. */
async function createCapturedDraft(opts: {
  prompt: string;
  gold: string;
  captures: string[];
}): Promise<string> {
  const created = await createDraftTool.handler(
    createDraftTool.input.parse({
      task_type: 'numeric',
      prompt: opts.prompt,
      gold: opts.gold,
      grader: { kind: 'numeric', target: opts.gold, rel_tol: 1e-6 },
      discrimination: { positive: [], negative: ['0'] },
      metadata: { domain: 'finance.filings', tags: ['edgar'] },
      verification: {
        method: 'external_source',
        generation_method: 'model_recall',
        evidence: [{ type: 'note', text: 'grounded in EDGAR capture' }],
      },
      captures: opts.captures,
    }),
    createCtx,
  );
  return created.draft_id;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'evals-capdata-'));
  captureDir = await mkdtemp(join(tmpdir(), 'evals-capdir-'));
  process.env.EVALS_DATA_DIR = dataDir;
  process.env.EVALS_CAPTURE_DIR = captureDir;
  delete process.env.EVALS_DEFAULT_LICENSE;
  resetServerConfig();
  await initRecordStoreService(dataDir, captureDir).init();
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(captureDir, { recursive: true, force: true });
  resetServerConfig();
  delete process.env.EVALS_CAPTURE_DIR;
});

describe('evals_submit_draft — capture resolution', () => {
  it('refuses capture_unresolved when a referenced capture file is missing', async () => {
    const id = await createCapturedDraft({
      prompt: 'Missing capture — AAPL revenue?',
      gold: '391035000000',
      captures: ['secedgar_missing0'],
    });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({ data: { reason: 'capture_unresolved' } });
    // Still a draft.
    expect(
      (await getRecordTool.handler(getRecordTool.input.parse({ id }), ctx)).record,
    ).toMatchObject({ status: 'draft' });
  });

  it('refuses capture_unresolved when the referenced capture recorded a failed tool call', async () => {
    await writeCapture('secedgar_err00000', {
      isError: true,
      structuredContent: { error: { code: 'ServiceUnavailable', message: 'down' } },
    });
    const id = await createCapturedDraft({
      prompt: 'Errored capture — AAPL revenue?',
      gold: '391035000000',
      captures: ['secedgar_err00000'],
    });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({ data: { reason: 'capture_unresolved' } });
  });

  it('refuses verification_disagrees_with_gold when the captured value contradicts the gold', async () => {
    // Capture says 391035000000 but the gold claims a different number.
    await writeCapture('secedgar_real0000', { structuredContent: 391035000000 });
    const id = await createCapturedDraft({
      prompt: 'Wrong gold vs capture — AAPL revenue?',
      gold: '999999999999',
      captures: ['secedgar_real0000'],
    });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({ data: { reason: 'verification_disagrees_with_gold' } });
  });

  it('submits when the captured value agrees, embedding the dump and lifting a source citation', async () => {
    await writeCapture('secedgar_ok000000', {
      structuredContent: 391035000000,
      traceId: 'abc123',
    });
    const id = await createCapturedDraft({
      prompt: 'Agreeing capture — AAPL revenue?',
      gold: '391035000000',
      captures: ['secedgar_ok000000'],
    });
    const submitted = await submitDraftTool.handler(
      submitDraftTool.input.parse({ draft_id: id }),
      submitCtx,
    );
    expect(submitted.status).toBe('submitted');

    // The frozen record embeds the capture and lifts a source_provenance entry.
    const frozen = (await getRecordTool.handler(getRecordTool.input.parse({ id }), ctx))
      .record as EvalRecord;
    expect(frozen.captured_outputs).toHaveLength(1);
    expect(frozen.captured_outputs?.[0].evals_id).toBe('secedgar_ok000000');
    const lifted = frozen.metadata.source_provenance ?? [];
    expect(lifted.some((s) => s.server === 'secedgar' && s.uri === 'trace:abc123')).toBe(true);
  });
});
