/**
 * @fileoverview Tests for server-config — EVALS_DATA_DIR resolution. The bare-npx
 * default (`./evals-data`) must apply both when the env var is unset and when it
 * is blank: the `.mcpb` bundle passes `""` (not undefined) for an empty Desktop
 * directory field, so `.min(1)` alone would crash startup. An explicit value is
 * preserved verbatim.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

const KEY = 'EVALS_DATA_DIR';

describe('server-config — EVALS_DATA_DIR default', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
    resetServerConfig();
  });
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
    resetServerConfig();
  });

  it('defaults to ./evals-data when EVALS_DATA_DIR is unset', () => {
    delete process.env[KEY];
    resetServerConfig();
    expect(getServerConfig().dataDir).toBe('./evals-data');
  });

  it('defaults to ./evals-data when EVALS_DATA_DIR is blank (empty Desktop field → "")', () => {
    process.env[KEY] = '';
    resetServerConfig();
    expect(getServerConfig().dataDir).toBe('./evals-data');
  });

  it('treats a whitespace-only EVALS_DATA_DIR as blank and defaults', () => {
    process.env[KEY] = '   ';
    resetServerConfig();
    expect(getServerConfig().dataDir).toBe('./evals-data');
  });

  it('preserves an explicit EVALS_DATA_DIR verbatim', () => {
    process.env[KEY] = '/srv/evals/records';
    resetServerConfig();
    expect(getServerConfig().dataDir).toBe('/srv/evals/records');
  });
});
