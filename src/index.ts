#!/usr/bin/env node
/**
 * @fileoverview evals-mcp-server entry point — an authoring-loop MCP server that
 * turns an agent into an eval author. Wires the record-store, grader, and
 * exporter services and registers the authoring surface (the draft loop, the
 * deterministic checker, read/list/export, and the record resource).
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { evalRecordResource } from './mcp-server/resources/definitions/eval-record.resource.js';
import { createDraftTool } from './mcp-server/tools/definitions/create-draft.tool.js';
import { describeSchemaTool } from './mcp-server/tools/definitions/describe-schema.tool.js';
import { discardDraftTool } from './mcp-server/tools/definitions/discard-draft.tool.js';
import { exportRecordsTool } from './mcp-server/tools/definitions/export-records.tool.js';
import { getRecordTool } from './mcp-server/tools/definitions/get-record.tool.js';
import { listRecordsTool } from './mcp-server/tools/definitions/list-records.tool.js';
import { reviseDraftTool } from './mcp-server/tools/definitions/revise-draft.tool.js';
import { runCheckTool } from './mcp-server/tools/definitions/run-check.tool.js';
import { submitDraftTool } from './mcp-server/tools/definitions/submit-draft.tool.js';
import { initExporterService } from './services/exporter/exporter-service.js';
import { initRecordStoreService } from './services/record-store/record-store-service.js';

await createApp({
  name: 'evals-mcp-server',
  title: 'evals-mcp-server',
  instructions:
    'Call evals_describe_schema before evals_create_draft. Use the returned draft_id to read, revise, and submit the same record. Verify the gold by a different method from the one that produced it and record the evidence with evals_revise_draft before calling evals_submit_draft. Submit requires at least one negative case. A deterministic grader must pass the gold and every positive and reject every negative. Rubric scoring happens outside this server.',
  skills: 'skills',
  tools: [
    describeSchemaTool,
    createDraftTool,
    getRecordTool,
    reviseDraftTool,
    discardDraftTool,
    runCheckTool,
    submitDraftTool,
    listRecordsTool,
    exportRecordsTool,
  ],
  resources: [evalRecordResource],
  /**
   * evals_submit_draft's confirmation is a multi-round ctx.requestInput, which a
   * 2025-era HTTP client can answer only over a live session — so a stateless
   * HTTP start is refused at boot instead of breaking the gate. Never refuses stdio.
   */
  sessionMode: { require: 'stateful' },
  async setup() {
    const cfg = getServerConfig();
    const store = initRecordStoreService(cfg.dataDir, cfg.captureDir);
    await store.init();
    initExporterService();
  },
});
