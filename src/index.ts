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
    'Author verifiable eval records through the draft → review → revise → submit loop. Call evals_describe_schema for a task type, then evals_create_draft; the response parrots the record back with a review protocol and a ready subagent prompt. Spawn a fresh subagent (connected here) to verify the gold via evals_get_record + evals_run_check, then apply surgical fixes with evals_revise_draft and finalize with evals_submit_draft. The submit gate requires the gold to pass its own grader, ≥1 negative case to be rejected, and a recorded, decorrelated independent verification.',
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
  async setup() {
    const cfg = getServerConfig();
    const store = initRecordStoreService(cfg.dataDir, cfg.captureDir);
    await store.init();
    initExporterService();
  },
});
