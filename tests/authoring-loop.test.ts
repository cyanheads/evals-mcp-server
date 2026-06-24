/**
 * @fileoverview End-to-end test of the full authoring loop against a real temp
 * data dir: create_draft → run_check → revise_draft → get_record/list_records →
 * submit_draft → get_record/list_records → export_records, plus the submit-gate
 * refusals (wrong gold, missing negative, no verification, decorrelation,
 * duplicate) and discard. Drives the actual tool handlers with a mock context.
 * @module tests/integration/authoring-loop.test
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { discardDraftTool } from '@/mcp-server/tools/definitions/discard-draft.tool.js';
import { exportRecordsTool } from '@/mcp-server/tools/definitions/export-records.tool.js';
import { getRecordTool } from '@/mcp-server/tools/definitions/get-record.tool.js';
import { listRecordsTool } from '@/mcp-server/tools/definitions/list-records.tool.js';
import { reviseDraftTool } from '@/mcp-server/tools/definitions/revise-draft.tool.js';
import { runCheckTool } from '@/mcp-server/tools/definitions/run-check.tool.js';
import { submitDraftTool } from '@/mcp-server/tools/definitions/submit-draft.tool.js';
import { initExporterService } from '@/services/exporter/exporter-service.js';
import { initRecordStoreService } from '@/services/record-store/record-store-service.js';

let dataDir: string;
// A plain context for tools that throw only via service-layer factories.
const ctx = createMockContext();
// Contexts wired with each tool's error contract so handler-level ctx.fail(...) resolves.
const submitCtx = createMockContext({ errors: submitDraftTool.errors });
const reviseCtx = createMockContext({ errors: reviseDraftTool.errors });

/** A canonical, ready-to-submit probability draft input (gold passes, negative rejected). */
function probabilityDraftInput() {
  return createDraftTool.input.parse({
    task_type: 'numeric',
    prompt: 'A bag has 5 red and 3 blue marbles. Two are drawn without replacement. P(both red)?',
    gold: '5/14',
    grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
    discrimination: { positive: ['10/28', '0.357142857'], negative: ['25/64'] },
    metadata: { domain: 'math.probability', tags: ['combinatorics', 'without-replacement'] },
    author_model: 'claude-opus-4-8',
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'evals-test-'));
  process.env.EVALS_DATA_DIR = dataDir;
  process.env.EVALS_DEFAULT_LICENSE = 'CC-BY-4.0';
  delete process.env.EVALS_REQUIRE_CONFIRMATION;
  delete process.env.EVALS_CAPTURE_DIR;
  resetServerConfig();
  const store = initRecordStoreService(dataDir, undefined);
  await store.init();
  initExporterService();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  resetServerConfig();
});

describe('full authoring loop', () => {
  it('create → run_check → revise → submit → get/list → export', async () => {
    // --- 1. create_draft -------------------------------------------------
    const created = await createDraftTool.handler(probabilityDraftInput(), ctx);
    expect(created.status).toBe('draft');
    expect(created.draft_id).toMatch(/^ev_/);
    const id = created.draft_id;
    // Self-consistency passes (gold + positives pass, negative rejected) but not ready (no verification).
    expect(created.server_checks.self_consistency.grader_ok).toBe(true);
    expect(created.server_checks.self_consistency.verification_present).toBe(false);
    expect(created.server_checks.self_consistency.ready_to_submit).toBe(false);
    expect(created.suggested_subagent_prompt).toContain(id);
    // Default license was applied from EVALS_DEFAULT_LICENSE.
    expect((created.normalized_record as { metadata: { license?: string } }).metadata.license).toBe(
      'CC-BY-4.0',
    );

    // --- 2. run_check (subagent re-derives the gold) ---------------------
    const check = await runCheckTool.handler(
      runCheckTool.input.parse({
        grader: { kind: 'numeric', target: 'combinations(5,2)/combinations(8,2)' },
        candidates: ['5/14', '25/64'],
      }),
      ctx,
    );
    expect(check.results[0].pass).toBe(true); // 5/14 confirmed
    expect(check.results[1].pass).toBe(false); // 25/64 rejected
    expect(check.pass_count).toBe(1);

    // --- 3. revise_draft (loosen tolerance, record the subagent finding) -
    const revised = await reviseDraftTool.handler(
      reviseDraftTool.input.parse({
        draft_id: id,
        append: {
          'discrimination.positive': ['0.357'],
          'verification.evidence': [
            {
              type: 'subagent_review',
              model: 'claude-sonnet-4-6',
              method: 'independent_derivation',
              findings:
                'Gold confirmed via combinations; negative is the canonical with-replacement error.',
            },
          ],
        },
        set: { 'verification.method': 'subagent_independent_derivation' },
      }),
      ctx,
    );
    expect(revised.changed.length).toBeGreaterThanOrEqual(2);
    expect(revised.server_checks.self_consistency.ready_to_submit).toBe(true);

    // --- 4. get_record reflects the patch --------------------------------
    const fetched = await getRecordTool.handler(getRecordTool.input.parse({ id }), ctx);
    const rec = fetched.record as {
      discrimination: { positive: unknown[] };
      verification: { evidence: unknown[] };
    };
    expect(rec.discrimination.positive).toContain('0.357');
    expect(rec.verification.evidence.length).toBe(1);

    // --- 5. list_records shows the draft ---------------------------------
    const draftList = await listRecordsTool.handler(
      listRecordsTool.input.parse({ status: 'draft' }),
      ctx,
    );
    expect(draftList.records.some((r) => r.id === id)).toBe(true);

    // --- 6. submit_draft (the gate passes) -------------------------------
    const submitted = await submitDraftTool.handler(
      submitDraftTool.input.parse({ draft_id: id }),
      submitCtx,
    );
    expect(submitted.status).toBe('submitted');
    expect(submitted.frozen).toBe(true);
    expect(submitted.grader_run.gold).toBe('PASS');
    expect(submitted.grader_run.negatives).toContain('REJECTED');
    expect(submitted.grader_run.server_verified).toBe(true);
    expect(submitted.checksum).toMatch(/^sha256:/);
    expect(submitted.verification.evidence_count).toBe(1);

    // The id is stable; get_record resolves the now-submitted record.
    const afterSubmit = await getRecordTool.handler(getRecordTool.input.parse({ id }), ctx);
    expect((afterSubmit.record as { status: string }).status).toBe('submitted');

    // The draft file is gone; the submitted file exists.
    await expect(readFile(join(dataDir, 'drafts', `${id}.json`), 'utf8')).rejects.toThrow();
    const onDisk = JSON.parse(await readFile(join(dataDir, 'submitted', `${id}.json`), 'utf8'));
    expect(onDisk.status).toBe('submitted');
    expect(onDisk.checksum).toBe(submitted.checksum);

    // --- 7. export_records (JSONL artifact actually contains the record) -
    const exported = await exportRecordsTool.handler(
      exportRecordsTool.input.parse({ format: 'jsonl' }),
      ctx,
    );
    expect(exported.record_count).toBe(1);
    expect(exported.bytes).toBeGreaterThan(0);
    const artifact = await readFile(exported.path, 'utf8');
    const exportedRecord = JSON.parse(artifact.trim());
    expect(exportedRecord.id).toBe(id);
    expect(exportedRecord.grader.kind).toBe('numeric');
    // The preview is non-empty and reflects the record.
    expect(exported.preview).toContain(id);
  });

  it('exports to inspect format with the grader spec inline', async () => {
    const exported = await exportRecordsTool.handler(
      exportRecordsTool.input.parse({ format: 'inspect', domain: 'math.probability' }),
      ctx,
    );
    const artifact = JSON.parse(await readFile(exported.path, 'utf8'));
    expect(artifact.format).toBe('inspect');
    expect(artifact.samples[0].grader_spec.kind).toBe('numeric');
  });
});

describe('submit gate refusals (the record stays a draft)', () => {
  async function draftWithVerification(
    overrides: Partial<ReturnType<typeof probabilityDraftInput>>,
  ): Promise<string> {
    const created = await createDraftTool.handler(
      createDraftTool.input.parse({ ...probabilityDraftInput(), ...overrides }),
      ctx,
    );
    return created.draft_id;
  }

  it('refuses verification_incomplete when no evidence is recorded', async () => {
    const id = await draftWithVerification({ prompt: 'Distinct prompt A — P(both red)?' });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({
      data: { reason: 'verification_incomplete' },
    });
    // Still a draft.
    expect(
      (await getRecordTool.handler(getRecordTool.input.parse({ id }), ctx)).record,
    ).toMatchObject({ status: 'draft' });
  });

  it('refuses grader_failed_on_gold when the gold does not pass its grader', async () => {
    const id = await draftWithVerification({
      prompt: 'Distinct prompt B — wrong gold',
      gold: '99/100',
      verification: { method: 'note', evidence: [{ type: 'note', text: 'placeholder' }] },
    });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({
      data: { reason: 'grader_failed_on_gold' },
    });
  });

  it('refuses missing_negative_case when discrimination.negative is empty', async () => {
    const id = await draftWithVerification({
      prompt: 'Distinct prompt C — no negative',
      discrimination: { positive: ['10/28'], negative: [] },
      verification: { method: 'note', evidence: [{ type: 'note', text: 'placeholder' }] },
    });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({
      data: { reason: 'missing_negative_case' },
    });
  });

  it('refuses verification_disagrees_with_gold when a deterministic check computed a conflicting value', async () => {
    const id = await draftWithVerification({
      prompt: 'Distinct prompt D — disagreeing verification',
      verification: {
        method: 'independent_derivation',
        evidence: [
          {
            type: 'deterministic_check',
            tool: 'evals_run_check',
            claim: 'recompute',
            computed: '25/64',
            passed: true,
          },
        ],
      },
    });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({
      data: { reason: 'verification_disagrees_with_gold' },
    });
  });

  it('refuses decorrelation_violation when the verification path equals the generation path', async () => {
    const id = await draftWithVerification({
      prompt: 'Distinct prompt E — correlated review',
      verification: {
        method: 'sequential_derivation',
        generation_method: 'sequential_derivation',
        evidence: [
          {
            type: 'subagent_review',
            model: 'claude-sonnet-4-6',
            method: 'sequential_derivation',
            findings: 'looks right',
          },
        ],
      },
    });
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: id }), submitCtx),
    ).rejects.toMatchObject({
      data: { reason: 'decorrelation_violation' },
    });
  });

  it('refuses a duplicate of an already-submitted record', async () => {
    // Same task content as the first submitted record → same content_hash.
    const dupInput = createDraftTool.input.parse({
      ...probabilityDraftInput(),
      verification: { method: 'note', evidence: [{ type: 'note', text: 'placeholder' }] },
    });
    const dup = await createDraftTool.handler(dupInput, ctx);
    await expect(
      submitDraftTool.handler(submitDraftTool.input.parse({ draft_id: dup.draft_id }), submitCtx),
    ).rejects.toMatchObject({
      data: { reason: 'duplicate' },
    });
  });
});

describe('discard + frozen guards', () => {
  it('discards a draft and then reports not_found', async () => {
    const created = await createDraftTool.handler(
      createDraftTool.input.parse({
        ...probabilityDraftInput(),
        prompt: 'Distinct prompt F — to discard',
      }),
      ctx,
    );
    const discarded = await discardDraftTool.handler(
      discardDraftTool.input.parse({ draft_id: created.draft_id }),
      ctx,
    );
    expect(discarded.discarded).toBe(true);
    await expect(
      discardDraftTool.handler(discardDraftTool.input.parse({ draft_id: created.draft_id }), ctx),
    ).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('refuses to revise or discard a submitted (frozen) record', async () => {
    // Find the submitted record from the happy-path test.
    const submittedList = await listRecordsTool.handler(
      listRecordsTool.input.parse({ status: 'submitted' }),
      ctx,
    );
    const submittedId = submittedList.records[0]?.id;
    expect(submittedId).toBeDefined();
    await expect(
      reviseDraftTool.handler(
        reviseDraftTool.input.parse({ draft_id: submittedId!, set: { prompt: 'x' } }),
        reviseCtx,
      ),
    ).rejects.toMatchObject({
      data: { reason: 'record_frozen' },
    });
    await expect(
      discardDraftTool.handler(discardDraftTool.input.parse({ draft_id: submittedId! }), ctx),
    ).rejects.toMatchObject({
      data: { reason: 'record_frozen' },
    });
  });

  it('rejects a patch that targets the discriminant task_type', async () => {
    const created = await createDraftTool.handler(
      createDraftTool.input.parse({
        ...probabilityDraftInput(),
        prompt: 'Distinct prompt G — bad patch',
      }),
      ctx,
    );
    await expect(
      reviseDraftTool.handler(
        reviseDraftTool.input.parse({ draft_id: created.draft_id, set: { task_type: 'mcq' } }),
        reviseCtx,
      ),
    ).rejects.toMatchObject({
      data: { reason: 'invalid_patch_path' },
    });
  });
});
