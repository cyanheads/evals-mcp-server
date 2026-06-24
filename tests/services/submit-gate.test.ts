/**
 * @fileoverview Unit tests for the submit gate — each committability refusal
 * condition in isolation (grader_failed_on_gold, missing_negative_case,
 * negative_case_passed, verification_incomplete, verification_disagrees_with_gold,
 * decorrelation_violation, duplicate), the success verdict shape, and the
 * llm_rubric-without-sampling branch (steps 1–2 skipped, admitted on recorded
 * verification, server_verified=false). Drives runSubmitGate directly against a
 * temp-dir store so dedup reads hit real disk.
 * @module tests/services/submit-gate.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvalRecord } from '@/services/eval-record/schema.js';
import { runSubmitGate } from '@/services/eval-record/submit-gate.js';
import { RecordStoreService } from '@/services/record-store/record-store-service.js';

const ctx = createMockContext();

/** A submit-ready numeric record: gold passes, ≥1 negative rejected, decorrelated verification present. */
function readyRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  const rec = {
    id: 'ev_ready000000',
    status: 'draft',
    task_type: 'numeric',
    prompt: 'P(both red)?',
    gold: '5/14',
    grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
    discrimination: { positive: ['10/28'], negative: ['25/64'] },
    metadata: { domain: 'math.probability', tags: ['combinatorics'] },
    verification: {
      method: 'subagent_independent_derivation',
      generation_method: 'closed_form',
      evidence: [
        {
          type: 'subagent_review',
          model: 'claude-sonnet-4-6',
          method: 'independent_derivation',
          findings: 'Gold confirmed.',
        },
      ],
    },
    provenance: { author_model: 'm', created_at: '2026-06-23T00:00:00.000Z' },
    content_hash: '',
    ...overrides,
  } as EvalRecord;
  return rec;
}

describe('runSubmitGate — deterministic committability', () => {
  let dir: string;
  let store: RecordStoreService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-gate-'));
    store = new RecordStoreService(dir, undefined);
    await store.init();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a fully ready record and reports the verdict + decorrelation source', async () => {
    const rec = readyRecord();
    rec.content_hash = store.computeContentHash(rec);
    const result = await runSubmitGate(rec, store, { samplingAvailable: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grader_run.gold).toBe('PASS');
    expect(result.value.grader_run.negatives).toContain('REJECTED');
    expect(result.value.grader_run.server_verified).toBe(true);
    expect(result.value.verification.decorrelated_by).toContain('subagent');
    expect(result.value.verification.evidence_count).toBe(1);
  });

  it('refuses grader_failed_on_gold when the gold does not pass its grader', async () => {
    const result = await runSubmitGate(readyRecord({ gold: '99/100' }), store, {
      samplingAvailable: false,
    });
    expect(result).toMatchObject({ ok: false, failure: { reason: 'grader_failed_on_gold' } });
  });

  it('refuses missing_negative_case when discrimination.negative is empty', async () => {
    const result = await runSubmitGate(
      readyRecord({ discrimination: { positive: ['10/28'], negative: [] } }),
      store,
      { samplingAvailable: false },
    );
    expect(result).toMatchObject({ ok: false, failure: { reason: 'missing_negative_case' } });
  });

  it('refuses negative_case_passed when a negative passes the grader (and names the offender)', async () => {
    // '0.357' passes a 1e-3 tolerance numeric grader, so declaring it a negative is a grader that accepts a wrong answer.
    const result = await runSubmitGate(
      readyRecord({ discrimination: { positive: ['10/28'], negative: ['0.357'] } }),
      store,
      { samplingAvailable: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('negative_case_passed');
    expect(result.failure.data).toMatchObject({ index: 0, candidate: '0.357' });
  });

  it('refuses verification_incomplete when no evidence is recorded', async () => {
    const result = await runSubmitGate(
      readyRecord({ verification: { method: 'note', evidence: [] } }),
      store,
      { samplingAvailable: false },
    );
    expect(result).toMatchObject({ ok: false, failure: { reason: 'verification_incomplete' } });
  });

  it('refuses verification_disagrees_with_gold when a deterministic check computed a conflicting value', async () => {
    const result = await runSubmitGate(
      readyRecord({
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
      }),
      store,
      { samplingAvailable: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('verification_disagrees_with_gold');
    expect(result.failure.data).toMatchObject({ computed: '25/64' });
  });

  it('refuses verification_disagrees_with_gold when a deterministic check is marked passed:false even if it agrees', async () => {
    // computed agrees with gold, but passed:false signals the author saw a failure — the gate honors it.
    const result = await runSubmitGate(
      readyRecord({
        verification: {
          method: 'independent_derivation',
          evidence: [
            {
              type: 'deterministic_check',
              tool: 'evals_run_check',
              claim: 'recompute',
              computed: '5/14',
              passed: false,
            },
          ],
        },
      }),
      store,
      { samplingAvailable: false },
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: 'verification_disagrees_with_gold' },
    });
  });

  it('refuses decorrelation_violation when verification path equals generation path (case/space-insensitive)', async () => {
    const result = await runSubmitGate(
      readyRecord({
        verification: {
          method: 'Sequential Derivation',
          generation_method: 'sequential_derivation',
          evidence: [
            {
              type: 'subagent_review',
              model: 'claude-sonnet-4-6',
              method: '  Sequential_Derivation ',
              findings: 'ok',
            },
          ],
        },
      }),
      store,
      { samplingAvailable: false },
    );
    expect(result).toMatchObject({ ok: false, failure: { reason: 'decorrelation_violation' } });
  });

  it('refuses duplicate when a submitted record shares the content_hash', async () => {
    const first = readyRecord();
    first.content_hash = store.computeContentHash(first);
    await store.promoteToSubmitted(first, ctx);
    // A new draft (different id) with identical task content.
    const dup = readyRecord({ id: 'ev_dup0000000' });
    dup.content_hash = store.computeContentHash(dup);
    const result = await runSubmitGate(dup, store, { samplingAvailable: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('duplicate');
    expect(result.failure.data).toMatchObject({ existing_id: first.id });
  });
});

describe('runSubmitGate — llm_rubric without sampling', () => {
  let dir: string;
  let store: RecordStoreService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-gate-'));
    store = new RecordStoreService(dir, undefined);
    await store.init();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function rubricRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
    return readyRecord({
      id: 'ev_rubric00000',
      task_type: 'free_response',
      gold: 'A model answer.',
      grader: {
        kind: 'llm_rubric',
        criteria: [{ description: 'mentions key fact' }],
        judge_prompt: 'Grade it.',
        pass_threshold: 0.5,
      },
      ...overrides,
    });
  }

  it('admits on recorded verification alone with server_verified=false and gold SKIPPED', async () => {
    const rec = rubricRecord();
    rec.content_hash = store.computeContentHash(rec);
    const result = await runSubmitGate(rec, store, { samplingAvailable: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grader_run.server_verified).toBe(false);
    expect(result.value.grader_run.gold).toBe('SKIPPED');
  });

  it('still requires at least one declared negative case', async () => {
    const result = await runSubmitGate(
      rubricRecord({ discrimination: { positive: [], negative: [] } }),
      store,
      { samplingAvailable: false },
    );
    expect(result).toMatchObject({ ok: false, failure: { reason: 'missing_negative_case' } });
  });

  it('still requires a recorded independent verification', async () => {
    const result = await runSubmitGate(
      rubricRecord({ verification: { method: 'note', evidence: [] } }),
      store,
      { samplingAvailable: false },
    );
    expect(result).toMatchObject({ ok: false, failure: { reason: 'verification_incomplete' } });
  });
});
