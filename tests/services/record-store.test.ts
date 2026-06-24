/**
 * @fileoverview Unit tests for the record-store service against a real temp data
 * dir — the surgical dotted-path patch (set/append/unset, protected paths,
 * non-array/missing-array append, unset-nonexistent), content_hash semantics
 * (semantic-only, discrimination excluded), the drafts/ → submitted/ move with
 * freeze stamping, duplicate detection, summary listing (filters, sort, cap +
 * truncation), and capture resolution (invalid id, missing file, malformed JSON).
 * @module tests/services/record-store.test
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvalRecord } from '@/services/eval-record/schema.js';
import { RecordStoreService } from '@/services/record-store/record-store-service.js';

const ctx = createMockContext();

/** A minimal, valid draft record with all the fields the store touches. */
function draftRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'ev_aaaaaaaaaa',
    status: 'draft',
    task_type: 'numeric',
    prompt: 'P(both red)?',
    gold: '5/14',
    grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
    discrimination: { positive: ['10/28'], negative: ['25/64'] },
    metadata: { domain: 'math.probability', tags: ['combinatorics'] },
    verification: { method: 'unspecified', evidence: [] },
    provenance: { author_model: 'unknown', created_at: '2026-06-23T00:00:00.000Z' },
    content_hash: '',
    ...overrides,
  } as EvalRecord;
}

describe('RecordStoreService — CRUD and require()', () => {
  let dir: string;
  let store: RecordStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-store-'));
    store = new RecordStoreService(dir, undefined);
    await store.init();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a draft to drafts/<id>.json and reads it back', async () => {
    const rec = draftRecord();
    await store.writeDraft(rec, ctx);
    const onDisk = JSON.parse(await readFile(join(dir, 'drafts', `${rec.id}.json`), 'utf8'));
    expect(onDisk.id).toBe(rec.id);
    const read = await store.read(rec.id);
    expect(read?.id).toBe(rec.id);
  });

  it('read() returns null for a missing id', async () => {
    expect(await store.read('ev_missing000')).toBeNull();
  });

  it('require() throws not_found with recovery guidance for a missing id', async () => {
    const err = await store
      .require('ev_missing000')
      .catch((e) => e as { data?: unknown; message: string });
    expect((err as { data: { reason: string } }).data.reason).toBe('not_found');
    expect((err as { message: string }).message).toContain('evals_list_records');
  });

  it('parseRecord throws serializationError for on-disk corruption', async () => {
    await writeFile(join(dir, 'drafts', 'ev_corrupt0000.json'), '{ not json', 'utf8');
    await expect(store.read('ev_corrupt0000')).rejects.toMatchObject({
      message: expect.stringContaining('not valid JSON'),
    });
  });

  it('deleteDraft removes a draft and then reports not_found', async () => {
    const rec = draftRecord();
    await store.writeDraft(rec, ctx);
    await store.deleteDraft(rec.id, ctx);
    expect(await store.read(rec.id)).toBeNull();
    await expect(store.deleteDraft(rec.id, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('deleteDraft refuses a submitted (frozen) record', async () => {
    const rec = draftRecord();
    await store.writeDraft(rec, ctx);
    await store.promoteToSubmitted(rec, ctx);
    await expect(store.deleteDraft(rec.id, ctx)).rejects.toMatchObject({
      data: { reason: 'record_frozen' },
    });
  });
});

describe('RecordStoreService — computeContentHash', () => {
  const store = new RecordStoreService('/tmp/unused-hash', undefined);

  it('hashes only the semantic fields — discrimination changes do NOT change the hash', () => {
    const base = draftRecord();
    const differentNegatives = draftRecord({
      discrimination: { positive: ['10/28'], negative: ['99/100', '1/2'] },
    });
    expect(store.computeContentHash(base)).toBe(store.computeContentHash(differentNegatives));
  });

  it('changes when a semantic field (prompt / gold / grader) changes', () => {
    const base = draftRecord();
    expect(store.computeContentHash(draftRecord({ prompt: 'different' }))).not.toBe(
      store.computeContentHash(base),
    );
    expect(store.computeContentHash(draftRecord({ gold: '1/2' }))).not.toBe(
      store.computeContentHash(base),
    );
  });

  it('is key-order independent (canonicalized) and prefixed sha256:', () => {
    const a = store.computeContentHash(draftRecord());
    const b = store.computeContentHash(draftRecord());
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('RecordStoreService — applyPatch', () => {
  const store = new RecordStoreService('/tmp/unused-patch', undefined);

  it('set replaces a leaf and reports before/after', () => {
    const { record, changed } = store.applyPatch(draftRecord(), {
      set: { 'grader.rel_tol': 0.05 },
    });
    expect((record.grader as { rel_tol: number }).rel_tol).toBe(0.05);
    expect(changed).toEqual([{ op: 'set', path: 'grader.rel_tol', before: 1e-3, after: 0.05 }]);
  });

  it('append extends an existing array and records before/after', () => {
    const { record, changed } = store.applyPatch(draftRecord(), {
      append: { 'discrimination.positive': ['0.357'] },
    });
    expect(record.discrimination.positive).toEqual(['10/28', '0.357']);
    expect(changed[0]).toMatchObject({ op: 'append', path: 'discrimination.positive' });
  });

  it('append creates a missing DECLARED array path', () => {
    const rec = draftRecord();
    const { record } = store.applyPatch(rec, {
      append: {
        'metadata.source_provenance': [{ server: 's', query: 'q', value: 'v', retrieved_at: 't' }],
      },
    });
    expect(record.metadata.source_provenance).toHaveLength(1);
  });

  it('append to a non-array path throws invalid_patch_path', () => {
    expect(() => store.applyPatch(draftRecord(), { append: { prompt: ['x'] } })).toThrowError(
      /non-array/,
    );
  });

  it('append to an undeclared missing path throws invalid_patch_path', () => {
    expect(() =>
      store.applyPatch(draftRecord(), { append: { 'metadata.unknown_array': ['x'] } }),
    ).toThrowError(/not an existing declared-array field/);
  });

  it('unset removes a present field', () => {
    const rec = draftRecord({
      metadata: { domain: 'd', tags: ['t'], contamination_notes: 'risky' },
    });
    const { record, changed } = store.applyPatch(rec, { unset: ['metadata.contamination_notes'] });
    expect(
      (record.metadata as { contamination_notes?: string }).contamination_notes,
    ).toBeUndefined();
    expect(changed[0]).toMatchObject({ op: 'unset', before: 'risky' });
  });

  it('unset of a non-resolving path throws invalid_patch_path', () => {
    expect(() => store.applyPatch(draftRecord(), { unset: ['metadata.nope'] })).toThrowError(
      /does not resolve/,
    );
  });

  it.each([
    'id',
    'status',
    'task_type',
    'content_hash',
    'checksum',
    'submitted_at',
    'provenance.created_at',
  ])('refuses to set a protected field: %s', (path) => {
    expect(() => store.applyPatch(draftRecord(), { set: { [path]: 'x' } })).toThrowError(
      /Cannot set/,
    );
  });

  it('the task_type rejection explains to start a new draft', () => {
    const err = (() => {
      try {
        store.applyPatch(draftRecord(), { set: { task_type: 'mcq' } });
      } catch (e) {
        return e as { data?: { reason?: string }; message: string };
      }
    })();
    expect(err?.data?.reason).toBe('invalid_patch_path');
    expect(err?.message).toContain('start a new draft');
  });

  it('rejects an empty or malformed path', () => {
    expect(() => store.applyPatch(draftRecord(), { set: { '': 'x' } })).toThrowError(
      /Invalid patch path/,
    );
    expect(() => store.applyPatch(draftRecord(), { set: { '.bad': 'x' } })).toThrowError(
      /Invalid patch path/,
    );
  });

  it('recomputes content_hash when a semantic field is patched', () => {
    const rec = draftRecord();
    rec.content_hash = store.computeContentHash(rec);
    const { record } = store.applyPatch(rec, { set: { prompt: 'A brand new prompt' } });
    expect(record.content_hash).not.toBe(rec.content_hash);
    expect(record.content_hash).toMatch(/^sha256:/);
  });

  it('does not mutate the input record (operates on a clone)', () => {
    const rec = draftRecord();
    store.applyPatch(rec, { set: { 'metadata.domain': 'mutated' } });
    expect(rec.metadata.domain).toBe('math.probability');
  });
});

describe('RecordStoreService — promote + dedup', () => {
  let dir: string;
  let store: RecordStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-store-'));
    store = new RecordStoreService(dir, undefined);
    await store.init();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('promoteToSubmitted stamps submitted_at + checksum, flips status, and moves the file', async () => {
    const rec = draftRecord();
    rec.content_hash = store.computeContentHash(rec);
    await store.writeDraft(rec, ctx);
    const { record: frozen, path } = await store.promoteToSubmitted(rec, ctx);

    expect(frozen.status).toBe('submitted');
    expect(frozen.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(frozen.checksum).toMatch(/^sha256:/);
    expect(path).toContain(join('submitted', `${rec.id}.json`));
    // Draft file gone, submitted file present.
    expect(await store.read(rec.id)).toMatchObject({ status: 'submitted' });
    await expect(readFile(join(dir, 'drafts', `${rec.id}.json`), 'utf8')).rejects.toThrow();
  });

  it('findSubmittedDuplicate matches on content_hash and excludes the same id', async () => {
    const rec = draftRecord();
    rec.content_hash = store.computeContentHash(rec);
    await store.promoteToSubmitted(rec, ctx);

    expect(await store.findSubmittedDuplicate(rec.content_hash, 'ev_other00000')).toBe(rec.id);
    // Excluding the record's own id yields no duplicate.
    expect(await store.findSubmittedDuplicate(rec.content_hash, rec.id)).toBeNull();
    // A different hash is not a duplicate.
    expect(await store.findSubmittedDuplicate('sha256:nope', 'ev_other00000')).toBeNull();
  });
});

describe('RecordStoreService — listSummaries', () => {
  let dir: string;
  let store: RecordStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-store-'));
    store = new RecordStoreService(dir, undefined);
    await store.init();
    // Seed: two drafts + one submitted, different domains/tags/created_at.
    await store.writeDraft(
      draftRecord({
        id: 'ev_one0000000',
        metadata: { domain: 'math.probability', tags: ['combinatorics'] },
        provenance: { author_model: 'm', created_at: '2026-06-21T00:00:00.000Z' },
      }),
      ctx,
    );
    await store.writeDraft(
      draftRecord({
        id: 'ev_two0000000',
        metadata: { domain: 'finance.filings', tags: ['xbrl'] },
        provenance: { author_model: 'm', created_at: '2026-06-22T00:00:00.000Z' },
      }),
      ctx,
    );
    const submitted = draftRecord({
      id: 'ev_three00000',
      metadata: { domain: 'math.probability', tags: ['combinatorics', 'gold'] },
      provenance: { author_model: 'm', created_at: '2026-06-23T00:00:00.000Z' },
    });
    await store.promoteToSubmitted(submitted, ctx);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns all records newest-first when unfiltered', async () => {
    const { summaries, total, truncated } = await store.listSummaries({ limit: 50 });
    expect(total).toBe(3);
    expect(truncated).toBe(false);
    expect(summaries.map((s) => s.id)).toEqual(['ev_three00000', 'ev_two0000000', 'ev_one0000000']);
  });

  it('filters by status (draft / submitted)', async () => {
    const drafts = await store.listSummaries({ status: 'draft', limit: 50 });
    expect(drafts.summaries.every((s) => s.status === 'draft')).toBe(true);
    expect(drafts.total).toBe(2);
    const submitted = await store.listSummaries({ status: 'submitted', limit: 50 });
    expect(submitted.summaries.map((s) => s.id)).toEqual(['ev_three00000']);
    expect(submitted.summaries[0].submitted_at).toBeDefined();
  });

  it('filters by domain, task_type, and tag', async () => {
    expect((await store.listSummaries({ domain: 'finance.filings', limit: 50 })).total).toBe(1);
    expect((await store.listSummaries({ task_type: 'numeric', limit: 50 })).total).toBe(3);
    expect((await store.listSummaries({ task_type: 'mcq', limit: 50 })).total).toBe(0);
    expect((await store.listSummaries({ tag: 'gold', limit: 50 })).total).toBe(1);
    expect((await store.listSummaries({ tag: 'combinatorics', limit: 50 })).total).toBe(2);
  });

  it('truncates and reports total when the limit is hit', async () => {
    const { summaries, total, truncated } = await store.listSummaries({ limit: 2 });
    expect(summaries).toHaveLength(2);
    expect(total).toBe(3);
    expect(truncated).toBe(true);
  });
});

describe('RecordStoreService — resolveCapture', () => {
  it('returns null when EVALS_CAPTURE_DIR is unset (capture disabled)', async () => {
    const store = new RecordStoreService('/tmp/unused-cap', undefined);
    expect(store.captureEnabled).toBe(false);
    expect(await store.resolveCapture('secedgar_a1b2c3d4')).toBeNull();
  });

  it('rejects a malformed capture id with reason capture_unresolved', async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'evals-cap-'));
      const store = new RecordStoreService('/tmp/unused-cap', dir);
      expect(store.captureEnabled).toBe(true);
      await expect(store.resolveCapture('../etc/passwd')).rejects.toMatchObject({
        data: { reason: 'capture_unresolved' },
      });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the dir is set but the capture file is missing', async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'evals-cap-'));
      const store = new RecordStoreService('/tmp/unused-cap', dir);
      expect(await store.resolveCapture('secedgar_missing0')).toBeNull();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses a well-formed capture dump from disk', async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'evals-cap-'));
      const capture = {
        evals_id: 'secedgar_a1b2c3d4',
        ts: '2026-06-23T00:00:00.000Z',
        server: 'secedgar',
        serverVersion: '1.0.0',
        tool: 'secedgar_get_financials',
        args: { ticker: 'AAPL' },
        structuredContent: { revenue: 391035000000 },
        isError: false,
      };
      await writeFile(join(dir, 'secedgar_a1b2c3d4.json'), JSON.stringify(capture), 'utf8');
      const store = new RecordStoreService('/tmp/unused-cap', dir);
      const resolved = await store.resolveCapture('secedgar_a1b2c3d4');
      expect(resolved?.server).toBe('secedgar');
      expect(resolved?.isError).toBe(false);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws serializationError on a malformed capture JSON file', async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'evals-cap-'));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'secedgar_bad00000.json'), '{ corrupt', 'utf8');
      const store = new RecordStoreService('/tmp/unused-cap', dir);
      await expect(store.resolveCapture('secedgar_bad00000')).rejects.toMatchObject({
        message: expect.stringContaining('not valid JSON'),
      });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
