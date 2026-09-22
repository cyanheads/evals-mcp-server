/**
 * @fileoverview Boot-time enforcement of the stateful session requirement
 * `src/index.ts` declares. An HTTP start under MCP_SESSION_MODE=stateless must
 * refuse with the framework's ConfigurationError banner instead of coming up
 * with a submit confirmation no 2025-era client can answer. stdio has no
 * session mode, so the same value must not stop a stdio start. Runs the real
 * server process.
 * @module tests/integration/session-mode-boot.int.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  awaitHttpStartup,
  freePort,
  httpEnv,
  launchServer,
  type ServerProcess,
} from './helpers/server-process.js';

/**
 * Resolves with the first newline-delimited JSON-RPC message on the server's
 * stdout carrying `id`; rejects with the captured output if the process exits first.
 */
function responseLine(server: ServerProcess, id: number): Promise<Record<string, unknown>> {
  const stdout: Readable = server.child.stdout;
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.id !== id) continue;
        stdout.off('data', onData);
        resolve(message);
        return;
      }
    };
    stdout.on('data', onData);
    void server.exited.then((code) =>
      reject(new Error(`Server exited (${code}) before answering id ${id}:\n${server.output()}`)),
    );
  });
}

describe('session-mode boot enforcement', () => {
  let workDir: string;
  const servers: ServerProcess[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'evals-boot-'));
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    await rm(workDir, { recursive: true, force: true });
  });

  it('refuses an HTTP start under MCP_SESSION_MODE=stateless with a ConfigurationError', async () => {
    const port = await freePort();
    const server = launchServer(workDir, { ...httpEnv(port), MCP_SESSION_MODE: 'stateless' });
    servers.push(server);

    expect(await awaitHttpStartup(server, port)).toEqual({ kind: 'exited', code: 1 });

    // The framework prints this banner only for a ConfigurationError raised during startup.
    const output = server.output();
    expect(output).toContain('Configuration error — server failed to start');
    expect(output).toContain("Server declares sessionMode.require: 'stateful'");
    expect(output).toContain('MCP_SESSION_MODE=stateless');
    expect(output).toContain('Set MCP_SESSION_MODE=stateful or unset it.');
  });

  it('boots over stdio under MCP_SESSION_MODE=stateless and answers initialize', async () => {
    const server = launchServer(workDir, {
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_SESSION_MODE: 'stateless',
    });
    servers.push(server);

    const initialized = responseLine(server, 1);
    server.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'session-mode-boot-test', version: '1.0.0' },
        },
      })}\n`,
    );

    expect(await initialized).toMatchObject({
      result: { protocolVersion: '2025-11-25', serverInfo: { name: 'evals-mcp-server' } },
    });
    // stdin EOF is the stdio shutdown signal; a clean exit confirms a normal lifecycle.
    server.child.stdin.end();
    expect(await server.exited).toBe(0);
  });
});
