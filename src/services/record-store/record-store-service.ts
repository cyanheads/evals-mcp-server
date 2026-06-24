/**
 * @fileoverview The record-store service — the on-disk JSON tree under
 * EVALS_DATA_DIR (drafts/, submitted/, exports/). Owns create/read/list/delete,
 * the surgical dotted-path patch (set/append/unset), content_hash computation,
 * the drafts/ → submitted/ move with checksum + submitted_at stamping and
 * freeze, capture resolution from EVALS_CAPTURE_DIR, and export-file writes.
 * Storage is the local filesystem (not ctx.state) so records stay
 * human-inspectable, diffable, and version-controllable.
 * @module services/record-store/record-store-service
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  conflict,
  notFound,
  serializationError,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { nanoid } from 'nanoid';
import {
  type Capture,
  CaptureSchema,
  type EvalRecord,
  type RecordStatus,
  type RecordSummary,
} from '@/services/eval-record/schema.js';

/** A single surgical patch operation, normalized for the response `changed[]`. */
export interface PatchChange {
  after?: unknown;
  before?: unknown;
  op: 'set' | 'append' | 'unset';
  path: string;
}

/** Fields the store regards as semantic for `content_hash` (dedup key). */
const SEMANTIC_FIELDS = ['task_type', 'prompt', 'context', 'gold', 'grader', 'choices'] as const;

/**
 * Top-level record keys a surgical patch is forbidden from mutating directly —
 * these are server-owned identity/integrity anchors, or the discriminant.
 */
const PROTECTED_PATHS = new Set([
  'id',
  'status',
  'task_type',
  'content_hash',
  'checksum',
  'submitted_at',
  'provenance.created_at',
]);

/** Declared array fields whose missing path `append` may create. */
const DECLARED_ARRAY_PATHS = new Set([
  'discrimination.positive',
  'discrimination.negative',
  'metadata.tags',
  'metadata.source_provenance',
  'verification.evidence',
  'captures',
  'choices',
  'captured_outputs',
  'grader.normalize',
  'grader.criteria',
]);

export class RecordStoreService {
  private readonly draftsDir: string;
  private readonly submittedDir: string;
  private readonly exportsDir: string;

  constructor(
    dataDir: string,
    private readonly captureDir: string | undefined,
  ) {
    this.draftsDir = join(dataDir, 'drafts');
    this.submittedDir = join(dataDir, 'submitted');
    this.exportsDir = join(dataDir, 'exports');
  }

  /** Create the on-disk tree. Called once at startup. */
  async init(): Promise<void> {
    await mkdir(this.draftsDir, { recursive: true });
    await mkdir(this.submittedDir, { recursive: true });
    await mkdir(this.exportsDir, { recursive: true });
  }

  // ---- identity & integrity helpers --------------------------------------

  /** A fresh stable record id, `ev_<nanoid(10)>`. */
  newId(): string {
    return `ev_${nanoid(10)}`;
  }

  /** Stable, key-sorted JSON for hashing. */
  private static canonicalize(value: unknown): string {
    const sortKeys = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(sortKeys);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort())
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      return out;
    };
    return JSON.stringify(sortKeys(value));
  }

  /** SHA-256 over the semantic fields only (sorted keys) — the dedup key. */
  computeContentHash(record: Pick<EvalRecord, (typeof SEMANTIC_FIELDS)[number]>): string {
    const semantic: Record<string, unknown> = {};
    for (const f of SEMANTIC_FIELDS) {
      const v = (record as Record<string, unknown>)[f];
      if (v !== undefined) semantic[f] = v;
    }
    return `sha256:${createHash('sha256').update(RecordStoreService.canonicalize(semantic)).digest('hex')}`;
  }

  /** SHA-256 over the full record JSON with `submitted_at`/`checksum` excluded — the immutability anchor. */
  private computeChecksum(record: EvalRecord): string {
    const { submitted_at: _s, checksum: _c, ...rest } = record;
    return `sha256:${createHash('sha256').update(RecordStoreService.canonicalize(rest)).digest('hex')}`;
  }

  // ---- file paths --------------------------------------------------------

  private pathFor(status: RecordStatus, id: string): string {
    return join(status === 'draft' ? this.draftsDir : this.submittedDir, `${id}.json`);
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.${nanoid(6)}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  }

  // ---- CRUD --------------------------------------------------------------

  /** Persist a freshly-built draft record to drafts/<id>.json. */
  async writeDraft(record: EvalRecord, ctx: Context): Promise<void> {
    ctx.log.debug('Writing draft', { id: record.id });
    await this.writeAtomic(
      this.pathFor('draft', record.id),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  /** Read a record by id from either drafts/ or submitted/. Returns null when absent. */
  async read(id: string): Promise<EvalRecord | null> {
    for (const status of ['draft', 'submitted'] as const) {
      const text = await this.readFileOrNull(this.pathFor(status, id));
      if (text !== null) return this.parseRecord(text, id);
    }
    return null;
  }

  /** Read a record, throwing `not_found` when absent. */
  async require(id: string): Promise<EvalRecord> {
    const record = await this.read(id);
    if (!record) {
      throw notFound(
        `No eval record with id "${id}". Use evals_list_records to browse existing records.`,
        { reason: 'not_found', id },
      );
    }
    return record;
  }

  private async readFileOrNull(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private parseRecord(text: string, id: string): EvalRecord {
    try {
      return JSON.parse(text) as EvalRecord;
    } catch (err) {
      throw serializationError(
        `Record "${id}" on disk is not valid JSON (${(err as Error).message}).`,
        { id },
      );
    }
  }

  /** Delete a draft by id. Throws `not_found` (unknown id) or `record_frozen` (submitted). */
  async deleteDraft(id: string, ctx: Context): Promise<void> {
    const submitted = await this.readFileOrNull(this.pathFor('submitted', id));
    if (submitted !== null) {
      throw conflict(
        `Record "${id}" is submitted and frozen; submitted records cannot be discarded.`,
        { reason: 'record_frozen', id },
      );
    }
    const draftPath = this.pathFor('draft', id);
    const draft = await this.readFileOrNull(draftPath);
    if (draft === null) {
      throw notFound(`No draft with id "${id}" to discard.`, { reason: 'not_found', id });
    }
    await unlink(draftPath);
    ctx.log.info('Discarded draft', { id });
  }

  // ---- surgical patch ----------------------------------------------------

  /**
   * Apply set/append/unset operations to a draft in memory, returning the
   * mutated clone and the normalized `changed[]`. Recomputes content_hash when a
   * semantic field changed. Does NOT persist — the caller re-validates and writes.
   */
  applyPatch(
    record: EvalRecord,
    ops: { set?: Record<string, unknown>; append?: Record<string, unknown[]>; unset?: string[] },
  ): { record: EvalRecord; changed: PatchChange[] } {
    const next = structuredClone(record) as Record<string, unknown>;
    const changed: PatchChange[] = [];

    for (const [path, value] of Object.entries(ops.set ?? {})) {
      this.assertPatchable(path, 'set');
      const before = this.getPath(next, path);
      this.setPath(next, path, value);
      changed.push({ op: 'set', path, before, after: value });
    }

    for (const [path, items] of Object.entries(ops.append ?? {})) {
      this.assertPatchable(path, 'append');
      const target = this.getPath(next, path);
      if (target === undefined || target === null) {
        if (!DECLARED_ARRAY_PATHS.has(path)) {
          throw validationError(
            `Cannot append to "${path}" — it is not an existing declared-array field.`,
            { reason: 'invalid_patch_path', path },
          );
        }
        this.setPath(next, path, [...items]);
        changed.push({ op: 'append', path, before: undefined, after: this.getPath(next, path) });
      } else if (Array.isArray(target)) {
        const after = [...target, ...items];
        this.setPath(next, path, after);
        changed.push({ op: 'append', path, before: target, after });
      } else {
        throw validationError(`Cannot append to "${path}" — it resolves to a non-array value.`, {
          reason: 'invalid_patch_path',
          path,
        });
      }
    }

    for (const path of ops.unset ?? []) {
      this.assertPatchable(path, 'unset');
      const before = this.getPath(next, path);
      this.unsetPath(next, path);
      changed.push({ op: 'unset', path, before, after: undefined });
    }

    const result = next as unknown as EvalRecord;
    result.content_hash = this.computeContentHash(result);
    return { record: result, changed };
  }

  private assertPatchable(path: string, op: string): void {
    if (PROTECTED_PATHS.has(path)) {
      const why =
        path === 'task_type'
          ? 'changing the discriminant would invalidate the record; start a new draft instead'
          : 'it is a server-owned field';
      throw validationError(`Cannot ${op} "${path}" — ${why}.`, {
        reason: 'invalid_patch_path',
        path,
      });
    }
    if (path.length === 0 || path.startsWith('.') || path.endsWith('.')) {
      throw validationError(`Invalid patch path "${path}".`, {
        reason: 'invalid_patch_path',
        path,
      });
    }
  }

  private getPath(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object') return;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  private setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    const last = parts.pop();
    if (last === undefined)
      throw validationError(`Invalid patch path "${path}".`, {
        reason: 'invalid_patch_path',
        path,
      });
    let cur: Record<string, unknown> = obj;
    for (const part of parts) {
      const nextNode = cur[part];
      if (nextNode === undefined || nextNode === null) {
        cur[part] = {};
      } else if (typeof nextNode !== 'object' || Array.isArray(nextNode)) {
        throw validationError(`Cannot set "${path}" — segment "${part}" is not an object.`, {
          reason: 'invalid_patch_path',
          path,
        });
      }
      cur = cur[part] as Record<string, unknown>;
    }
    cur[last] = value;
  }

  private unsetPath(obj: Record<string, unknown>, path: string): void {
    const parts = path.split('.');
    const last = parts.pop();
    if (last === undefined)
      throw validationError(`Invalid patch path "${path}".`, {
        reason: 'invalid_patch_path',
        path,
      });
    let cur: unknown = obj;
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object') {
        throw validationError(`Cannot unset "${path}" — segment "${part}" does not resolve.`, {
          reason: 'invalid_patch_path',
          path,
        });
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === null || typeof cur !== 'object' || !(last in (cur as Record<string, unknown>))) {
      throw validationError(`Cannot unset "${path}" — it does not resolve against the record.`, {
        reason: 'invalid_patch_path',
        path,
      });
    }
    delete (cur as Record<string, unknown>)[last];
  }

  // ---- submit (move + freeze) --------------------------------------------

  /** True when a submitted record with the same content_hash already exists. Returns that record's id, or null. */
  async findSubmittedDuplicate(contentHash: string, exceptId: string): Promise<string | null> {
    for (const record of await this.listSubmittedRecords()) {
      if (record.id !== exceptId && record.content_hash === contentHash) return record.id;
    }
    return null;
  }

  /**
   * Finalize a validated draft: stamp submitted_at + checksum, set status,
   * move drafts/<id>.json → submitted/<id>.json. Returns the frozen record
   * (with checksum + submitted_at guaranteed) and its path.
   */
  async promoteToSubmitted(
    record: EvalRecord,
    ctx: Context,
  ): Promise<{ record: EvalRecord & { checksum: string; submitted_at: string }; path: string }> {
    const frozen = structuredClone(record) as EvalRecord & {
      checksum: string;
      submitted_at: string;
    };
    frozen.status = 'submitted';
    frozen.submitted_at = new Date().toISOString();
    frozen.checksum = this.computeChecksum(frozen);

    const submittedPath = this.pathFor('submitted', frozen.id);
    await this.writeAtomic(submittedPath, `${JSON.stringify(frozen, null, 2)}\n`);
    // Remove the draft only after the submitted file is durably written.
    await unlink(this.pathFor('draft', frozen.id)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
    ctx.log.notice('Promoted draft to submitted', { id: frozen.id, checksum: frozen.checksum });
    return { record: frozen, path: submittedPath };
  }

  // ---- listing -----------------------------------------------------------

  private async listIds(dir: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  }

  /** Read every submitted record (used for dedup + export). */
  listSubmittedRecords(): Promise<EvalRecord[]> {
    return this.readAll(this.submittedDir);
  }

  private async readAll(dir: string): Promise<EvalRecord[]> {
    const ids = await this.listIds(dir);
    const out: EvalRecord[] = [];
    for (const id of ids) {
      const text = await this.readFileOrNull(join(dir, `${id}.json`));
      if (text !== null) out.push(this.parseRecord(text, id));
    }
    return out;
  }

  /**
   * Browse and filter records into summary projections. Reads both trees unless
   * a status filter narrows it. Applies a hard cap and reports whether it was hit.
   */
  async listSummaries(filter: {
    status?: RecordStatus;
    domain?: string;
    task_type?: string;
    tag?: string;
    limit: number;
  }): Promise<{ summaries: RecordSummary[]; total: number; truncated: boolean }> {
    const dirs: Array<{ status: RecordStatus; dir: string }> = [];
    if (filter.status === 'draft') dirs.push({ status: 'draft', dir: this.draftsDir });
    else if (filter.status === 'submitted')
      dirs.push({ status: 'submitted', dir: this.submittedDir });
    else {
      dirs.push(
        { status: 'draft', dir: this.draftsDir },
        { status: 'submitted', dir: this.submittedDir },
      );
    }

    const matches: RecordSummary[] = [];
    for (const { dir } of dirs) {
      for (const record of await this.readAll(dir)) {
        if (filter.domain && record.metadata.domain !== filter.domain) continue;
        if (filter.task_type && record.task_type !== filter.task_type) continue;
        if (filter.tag && !record.metadata.tags.includes(filter.tag)) continue;
        matches.push({
          id: record.id,
          status: record.status,
          task_type: record.task_type,
          domain: record.metadata.domain,
          tags: record.metadata.tags,
          created_at: record.provenance.created_at,
          ...(record.submitted_at ? { submitted_at: record.submitted_at } : {}),
        });
      }
    }

    matches.sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
    const total = matches.length;
    const truncated = total > filter.limit;
    return { summaries: matches.slice(0, filter.limit), total, truncated };
  }

  // ---- exports -----------------------------------------------------------

  /** Write a compiled export artifact under exports/ and return its absolute path + byte size. */
  async writeExport(
    filenameStem: string,
    ext: string,
    content: string,
    ctx: Context,
  ): Promise<{ path: string; bytes: number }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.exportsDir, `${stamp}-${filenameStem}.${ext}`);
    await this.writeAtomic(path, content);
    const bytes = Buffer.byteLength(content, 'utf8');
    ctx.log.info('Wrote export', { path, bytes });
    return { path, bytes };
  }

  // ---- capture resolution (EvalsID) --------------------------------------

  /** True when EVALS_CAPTURE_DIR is configured (capture resolution is active). */
  get captureEnabled(): boolean {
    return this.captureDir !== undefined;
  }

  /**
   * Resolve a capture EvalsID to its full dump from EVALS_CAPTURE_DIR. Returns
   * null when the dir is set but the file is missing (caller raises
   * `capture_unresolved`). The id is sanitized to a single path segment.
   */
  async resolveCapture(evalsId: string): Promise<Capture | null> {
    if (this.captureDir === undefined) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(evalsId)) {
      throw validationError(
        `Invalid capture id "${evalsId}" — expected "<server-prefix>_<shortid>".`,
        { reason: 'capture_unresolved', evals_id: evalsId },
      );
    }
    const text = await this.readFileOrNull(join(this.captureDir, `${evalsId}.json`));
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw serializationError(
        `Capture "${evalsId}" is not valid JSON (${(err as Error).message}).`,
        { evals_id: evalsId },
      );
    }
    return CaptureSchema.parse(parsed);
  }
}

// --- Init/accessor pattern ---

let _service: RecordStoreService | undefined;

export function initRecordStoreService(
  dataDir: string,
  captureDir: string | undefined,
): RecordStoreService {
  _service = new RecordStoreService(dataDir, captureDir);
  return _service;
}

export function getRecordStoreService(): RecordStoreService {
  if (!_service) {
    throw new Error(
      'RecordStoreService not initialized — call initRecordStoreService() in setup()',
    );
  }
  return _service;
}
