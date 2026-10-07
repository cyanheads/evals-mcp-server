/**
 * @fileoverview Caller-bound, single-use submit consent using real draft storage.
 * @module tests/tools/submit-consent.tool.test
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMockContext,
  expectInputRequired,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { submitDraftTool } from '@/mcp-server/tools/definitions/submit-draft.tool.js';
import {
  getRecordStoreService,
  initRecordStoreService,
} from '@/services/record-store/record-store-service.js';

const accepted = { submit_confirmation: { action: 'accept' as const, content: { confirm: true } } };
const mock = (options: Parameters<typeof createMockContext>[0] = {}) =>
  createMockContext({
    errors: submitDraftTool.errors,
    clientCapabilities: { elicitation: { form: {} } },
    ...options,
  });
let dataDir: string;
let draftId: string;
const input = () => submitDraftTool.input.parse({ draft_id: draftId, confirm: true });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'evals-consent-'));
  vi.stubEnv('EVALS_DATA_DIR', dataDir);
  vi.stubEnv('EVALS_REQUIRE_CONFIRMATION', 'false');
  resetServerConfig();
  await initRecordStoreService(dataDir, undefined).init();
  const created = await createDraftTool.handler(
    createDraftTool.input.parse({
      task_type: 'numeric',
      prompt: 'What is two plus three?',
      gold: '5',
      grader: { kind: 'numeric', target: 5 },
      discrimination: { positive: ['5'], negative: ['4'] },
      metadata: { domain: 'math', tags: [] },
      verification: {
        method: 'independent_derivation',
        evidence: [{ type: 'note', text: 'Added independently.' }],
      },
    }),
    createMockContext({ errors: createDraftTool.errors }),
  );
  draftId = created.draft_id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  resetServerConfig();
  await rm(dataDir, { recursive: true, force: true });
});

describe('submit consent', () => {
  it('keeps the draft unchanged while asking for confirmation', async () => {
    const asked = await expectInputRequired(() => submitDraftTool.handler(input(), mock()));
    expect(asked.inputRequests).toHaveProperty('submit_confirmation');
    expect((await getRecordStoreService().require(draftId)).status).toBe('draft');
  });

  it('asks again rather than trusting an unprompted accepted answer', async () => {
    await expectInputRequired(() =>
      submitDraftTool.handler(input(), mock({ inputResponses: accepted })),
    );
    expect((await getRecordStoreService().require(draftId)).status).toBe('draft');
  });

  it.each([{}, { elicitation: { url: {} } }])(
    'filters pre-answered forms without form capability: %j',
    async (clientCapabilities) => {
      await expectInputRequired(() =>
        submitDraftTool.handler(input(), mock({ clientCapabilities, inputResponses: accepted })),
      );
      expect((await getRecordStoreService().require(draftId)).status).toBe('draft');
    },
  );

  async function round() {
    const first = mock();
    const asked = await expectInputRequired(() => submitDraftTool.handler(input(), first));
    expect(asked.requestState).toEqual(expect.any(String));
    const key = `consent/${asked.requestState}`;
    const record = await first.state.get(key);
    expect(record).toMatchObject({
      operation: 'evals_submit_draft',
      target: draftId,
      clientId: '',
      subject: '',
      contentHash: expect.any(String),
    });
    const second = mock({ inputResponses: accepted, requestState: asked.requestState });
    await second.state.set(key, record, { ttl: 600 });
    return { asked, key, record, second };
  }

  it('redeems matching consent and emits submission in both output surfaces', async () => {
    const { key, second } = await round();
    const result = await runToolContract(
      { ...submitDraftTool, handler: () => submitDraftTool.handler(input(), second) },
      input(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      id: draftId,
      status: 'submitted',
      frozen: true,
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(`${draftId} is now submitted`),
        }),
      ]),
    );
    expect(await second.state.get(key)).toBeNull();
  });

  it.each(['operation', 'clientId', 'subject', 'target', 'contentHash'] as const)(
    'asks again when %s differs',
    async (field) => {
      const { key, record, second } = await round();
      await second.state.set(key, { ...(record as Record<string, unknown>), [field]: 'different' });
      const asked = await expectInputRequired(() => submitDraftTool.handler(input(), second));
      expect(`consent/${asked.requestState}`).not.toBe(key);
      expect(await second.state.get(key)).toBeNull();
      expect((await getRecordStoreService().require(draftId)).status).toBe('draft');
    },
  );

  it('rejects a sequential replay after a declined round', async () => {
    const { key, second } = await round();
    const record = await second.state.get(key);
    const declined = mock({
      requestState: second.inputs.state(),
      inputResponses: { submit_confirmation: { action: 'decline' } },
    });
    await declined.state.set(key, record);
    const result = await runToolContract(
      { ...submitDraftTool, handler: () => submitDraftTool.handler(input(), declined) },
      input(),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: {
          reason: 'submit_declined',
          recovery: { hint: expect.stringContaining('accept the confirmation') },
        },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('accept the confirmation') }),
      ]),
    );
    const replay = mock({ requestState: second.inputs.state(), inputResponses: accepted });
    const spent = await declined.state.get(key);
    expect(spent).toBeNull();
    await expectInputRequired(() => submitDraftTool.handler(input(), replay));
  });

  it('invalidates consent when non-semantic draft metadata changes', async () => {
    const { second } = await round();
    const store = getRecordStoreService();
    const record = await store.require(draftId);
    record.metadata.tags = ['changed'];
    await store.writeDraft(record, mock());
    await expectInputRequired(() => submitDraftTool.handler(input(), second));
    expect((await store.require(draftId)).status).toBe('draft');
  });

  it('asks again for an unknown consent id', async () => {
    await expectInputRequired(() =>
      submitDraftTool.handler(
        input(),
        mock({ requestState: '00000000-0000-4000-8000-000000000000', inputResponses: accepted }),
      ),
    );
    expect((await getRecordStoreService().require(draftId)).status).toBe('draft');
  });

  it('asks again after consent expires', async () => {
    const { second, key } = await round();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 601_000);
      await expectInputRequired(() => submitDraftTool.handler(input(), second));
      expect(await second.state.get(key)).toBeNull();
      expect((await getRecordStoreService().require(draftId)).status).toBe('draft');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['cancel', 'accept'] as const)(
    'refuses a valid consent round with %s and confirm false',
    async (action) => {
      const { asked, key, record } = await round();
      const second = mock({
        requestState: asked.requestState,
        inputResponses: { submit_confirmation: { action, content: { confirm: false } } },
      });
      await second.state.set(key, record);
      await expect(submitDraftTool.handler(input(), second)).rejects.toMatchObject({
        code: -32007,
        data: { reason: 'submit_declined' },
      });
      expect(await second.state.get(key)).toBeNull();
      expect((await getRecordStoreService().require(draftId)).status).toBe('draft');
    },
  );
});
