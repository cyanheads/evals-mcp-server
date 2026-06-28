/**
 * @fileoverview Server-specific configuration for evals-mcp-server — the four
 * `EVALS_*` environment variables that drive the on-disk record store, the
 * submit-confirmation gate, the default record license, and the provenance
 * capture directory. Lazy-parsed via `parseEnvConfig` so env validation errors
 * name the variable (e.g. `EVALS_DATA_DIR`) rather than the Zod path.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  dataDir: z.preprocess(
    // A blank EVALS_DATA_DIR (the .mcpb bundle sends "" for an empty Desktop directory field) is treated as unset so the default applies.
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .min(1)
      .default('./evals-data')
      .describe(
        'Root folder for record JSON. The store manages drafts/, submitted/, and exports/ under it.',
      ),
  ),
  requireConfirmation: z
    .stringbool()
    .default(false)
    .describe(
      'When true, evals_submit_draft fires ctx.elicit for human confirmation where the client supports it.',
    ),
  defaultLicense: z
    .string()
    .optional()
    .describe('Default metadata.license applied when a draft omits one.'),
  captureDir: z
    .string()
    .optional()
    .describe(
      'Directory of framework-written tool-call captures. When set, captures EvalsIDs resolve to full dumps.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server configuration from the environment.
 * Throws `ConfigurationError` (rendered as a startup banner) when a value is
 * malformed. `EVALS_DATA_DIR` defaults to `./evals-data` when unset or blank.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    dataDir: 'EVALS_DATA_DIR',
    requireConfirmation: 'EVALS_REQUIRE_CONFIRMATION',
    defaultLicense: 'EVALS_DEFAULT_LICENSE',
    captureDir: 'EVALS_CAPTURE_DIR',
  });
  return _config;
}

/** Reset the cached config. Test-only seam. */
export function resetServerConfig(): void {
  _config = undefined;
}
