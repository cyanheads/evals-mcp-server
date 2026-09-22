/**
 * @fileoverview The MCP_SESSION_MODE posture of the two shipped deployment
 * surfaces: the container image (`Dockerfile`) and the operator template
 * (`.env.example`). Both must set `stateful` — evals_submit_draft's confirmation
 * is a multi-round `ctx.requestInput`, which a 2025-era HTTP client can answer
 * only over a live session, and `src/index.ts` refuses a stateless HTTP start.
 * @module tests/config/session-mode-posture.test
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

/** Capture group 1 of every match of `pattern` in `text`, in file order. */
const assigned = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((match) => match[1]);

describe('MCP_SESSION_MODE deployment posture', () => {
  it('the Dockerfile image sets MCP_SESSION_MODE to stateful', async () => {
    const values = assigned(
      await read('Dockerfile'),
      /^ENV\s+MCP_SESSION_MODE="?([^"\s]*)"?\s*$/gm,
    );
    expect(values).toEqual(['stateful']);
  });

  it('.env.example sets MCP_SESSION_MODE to stateful on an active line', async () => {
    const values = assigned(await read('.env.example'), /^MCP_SESSION_MODE=(\S*)/gm);
    expect(values).toEqual(['stateful']);
  });
});
