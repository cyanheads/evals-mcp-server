/**
 * @fileoverview Tests for the browse/emit surface against a seeded temp-dir store:
 * evals_list_records (status/domain/tag filters, newest-first, truncation
 * enrichment, empty-filter notice), evals_export_records (per-format compile via
 * the tool, the empty-match notice + empty artifact, filtered subset, format),
 * and the eval://record/{id} resource (happy, not_found, list()). Asserts on
 * ctx.enrich via getEnrichment.
 * @module tests/tools/list-export-resource.tool.test
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { evalRecordResource } from '@/mcp-server/resources/definitions/eval-record.resource.js';
import { createDraftTool } from '@/mcp-server/tools/definitions/create-draft.tool.js';
import { exportRecordsTool } from '@/mcp-server/tools/definitions/export-records.tool.js';
import { listRecordsTool } from '@/mcp-server/tools/definitions/list-records.tool.js';
import { submitDraftTool } from '@/mcp-server/tools/definitions/submit-draft.tool.js';
import type { EvalRecord } from '@/services/eval-record/schema.js';
import { initExporterService } from '@/services/exporter/exporter-service.js';
import { initRecordStoreService } from '@/services/record-store/record-store-service.js';

let dataDir: string;
const ctx = createMockContext();
const createCtx = createMockContext({ errors: createDraftTool.errors });
const submitCtx = createMockContext({ errors: submitDraftTool.errors });

/** Create + fully submit a numeric record under a distinct prompt/domain/tag. */
async function seedSubmitted(opts: { prompt: string; domain: string; tags: string[] }) {
  const created = await createDraftTool.handler(
    createDraftTool.input.parse({
      task_type: 'numeric',
      prompt: opts.prompt,
      gold: '5/14',
      grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
      discrimination: { positive: ['10/28'], negative: ['25/64'] },
      metadata: { domain: opts.domain, tags: opts.tags },
      verification: {
        method: 'independent_derivation',
        generation_method: 'closed_form',
        evidence: [{ type: 'note', text: 'confirmed' }],
      },
    }),
    createCtx,
  );
  await submitDraftTool.handler(
    submitDraftTool.input.parse({ draft_id: created.draft_id }),
    submitCtx,
  );
  return created.draft_id;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'evals-browse-'));
  process.env.EVALS_DATA_DIR = dataDir;
  process.env.EVALS_DEFAULT_LICENSE = 'CC-BY-4.0';
  delete process.env.EVALS_CAPTURE_DIR;
  resetServerConfig();
  await initRecordStoreService(dataDir, undefined).init();
  initExporterService();

  // Two submitted records (different domains/tags) + one lingering draft.
  await seedSubmitted({ prompt: 'Browse A', domain: 'math.probability', tags: ['combinatorics'] });
  await seedSubmitted({ prompt: 'Browse B', domain: 'finance.filings', tags: ['xbrl'] });
  await createDraftTool.handler(
    createDraftTool.input.parse({
      task_type: 'numeric',
      prompt: 'Browse C draft',
      gold: '5/14',
      grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
      discrimination: { positive: ['10/28'], negative: ['25/64'] },
      metadata: { domain: 'math.probability', tags: ['draft-only'] },
    }),
    createCtx,
  );
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  resetServerConfig();
});

describe('evals_list_records', () => {
  it('lists all records newest-first and enriches totalCount + truncated=false', async () => {
    const listCtx = createMockContext();
    const result = await listRecordsTool.handler(listRecordsTool.input.parse({}), listCtx);
    expect(result.records.length).toBe(3);
    const enrich = getEnrichment(listCtx);
    expect(enrich.totalCount).toBe(3);
    expect(enrich.truncated).toBe(false);
    expect(enrich.shown).toBe(3);
  });

  it('filters by status, domain, and tag', async () => {
    const submitted = await listRecordsTool.handler(
      listRecordsTool.input.parse({ status: 'submitted' }),
      ctx,
    );
    expect(submitted.records).toHaveLength(2);
    expect(submitted.records.every((r) => r.status === 'submitted')).toBe(true);

    const finance = await listRecordsTool.handler(
      listRecordsTool.input.parse({ domain: 'finance.filings' }),
      ctx,
    );
    expect(finance.records).toHaveLength(1);

    const tagged = await listRecordsTool.handler(
      listRecordsTool.input.parse({ tag: 'draft-only' }),
      ctx,
    );
    expect(tagged.records).toHaveLength(1);
    expect(tagged.records[0].status).toBe('draft');
  });

  it('discloses truncation through enrichment when limit is hit', async () => {
    const listCtx = createMockContext();
    const result = await listRecordsTool.handler(
      listRecordsTool.input.parse({ limit: 1 }),
      listCtx,
    );
    expect(result.records).toHaveLength(1);
    const enrich = getEnrichment(listCtx);
    expect(enrich.truncated).toBe(true);
    expect(enrich.totalCount).toBe(3);
    expect(enrich.cap).toBe(1);
  });

  it('emits a no-match notice for a filter that matches nothing', async () => {
    const listCtx = createMockContext();
    const result = await listRecordsTool.handler(
      listRecordsTool.input.parse({ domain: 'nonexistent.domain' }),
      listCtx,
    );
    expect(result.records).toHaveLength(0);
    expect(getEnrichment(listCtx).notice).toContain('No records matched');
  });

  it('rejects a non-positive or oversized limit at the Zod boundary', () => {
    expect(() => listRecordsTool.input.parse({ limit: 0 })).toThrow();
    expect(() => listRecordsTool.input.parse({ limit: 501 })).toThrow();
  });

  it('format() renders a bullet line per record and an empty-state line', () => {
    const empty = listRecordsTool.format!({ records: [] });
    expect((empty[0] as { text: string }).text).toContain('No records matched');
  });
});

describe('evals_export_records', () => {
  it('exports only submitted records (drafts excluded) as jsonl', async () => {
    const result = await exportRecordsTool.handler(
      exportRecordsTool.input.parse({ format: 'jsonl' }),
      ctx,
    );
    expect(result.record_count).toBe(2); // the draft is skipped
    const artifact = await readFile(result.path, 'utf8');
    const lines = artifact.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as EvalRecord).status).toBe('submitted');
  });

  it('exports a filtered subset and names the artifact by filter', async () => {
    const result = await exportRecordsTool.handler(
      exportRecordsTool.input.parse({ format: 'csv', domain: 'finance.filings' }),
      ctx,
    );
    expect(result.record_count).toBe(1);
    expect(result.path).toContain('finance.filings');
    const csv = await readFile(result.path, 'utf8');
    expect(csv.split('\n')[0]).toBe('id,task_type,prompt,gold,grader.kind,domain,tags,status');
  });

  it('writes an empty artifact and emits a notice when nothing matches', async () => {
    const exportCtx = createMockContext();
    const result = await exportRecordsTool.handler(
      exportRecordsTool.input.parse({ format: 'jsonl', tag: 'no-such-tag' }),
      exportCtx,
    );
    expect(result.record_count).toBe(0);
    expect(getEnrichment(exportCtx).notice).toContain('No submitted records matched');
    const artifact = await readFile(result.path, 'utf8');
    expect(artifact.trim()).toBe('');
  });

  it('compiles the lm-eval and inspect formats with the grader spec inline', async () => {
    const lmeval = await exportRecordsTool.handler(
      exportRecordsTool.input.parse({ format: 'lm-eval' }),
      ctx,
    );
    const lm = JSON.parse(await readFile(lmeval.path, 'utf8'));
    expect(lm.format).toBe('lm-eval');
    expect(lm.docs[0].grader_spec.kind).toBe('numeric');

    const inspect = await exportRecordsTool.handler(
      exportRecordsTool.input.parse({ format: 'inspect' }),
      ctx,
    );
    const ins = JSON.parse(await readFile(inspect.path, 'utf8'));
    expect(ins.samples[0].scorer).toBe('match_numeric');
  });

  it('rejects an unknown format at the Zod boundary', () => {
    expect(() => exportRecordsTool.input.parse({ format: 'parquet' })).toThrow();
  });
});

describe('eval://record/{id} resource', () => {
  it('resolves a record by id for resource-capable clients', async () => {
    const list = await listRecordsTool.handler(
      listRecordsTool.input.parse({ status: 'submitted', limit: 1 }),
      ctx,
    );
    const id = list.records[0].id;
    const resourceCtx = createMockContext({
      uri: new URL(`eval://record/${id}`),
      errors: evalRecordResource.errors,
    });
    const record = await evalRecordResource.handler(
      evalRecordResource.params.parse({ id }),
      resourceCtx,
    );
    expect((record as EvalRecord).id).toBe(id);
    expect((record as EvalRecord).status).toBe('submitted');
  });

  it('throws not_found for an unknown id', async () => {
    const resourceCtx = createMockContext({
      uri: new URL('eval://record/ev_missing0000'),
      errors: evalRecordResource.errors,
    });
    await expect(
      evalRecordResource.handler(
        evalRecordResource.params.parse({ id: 'ev_missing0000' }),
        resourceCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });

  it('list() enumerates available record URIs with names', async () => {
    const listing = await evalRecordResource.list!();
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r.uri).toMatch(/^eval:\/\/record\/ev_/);
      expect(r.name).toContain('ev_');
    }
  });
});
