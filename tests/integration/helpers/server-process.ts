/**
 * @fileoverview Runs the real server as a subprocess for black-box tests. The
 * entry point is `src/index.ts` on Bun, the runtime the image ships, so a test
 * exercises the current source without depending on a fresh `dist/`. The
 * child's environment drops every `MCP_*` and `EVALS_*` variable inherited from
 * the parent, and its working directory is a caller-owned temp dir, so neither
 * the invoking shell nor a developer's `.env` can change the configuration a
 * test declares — an omitted variable is genuinely unset.
 * @module tests/integration/helpers/server-process
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = fileURLToPath(new URL('../../../src/index.ts', import.meta.url));

/** A launched server process. */
export interface ServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with the exit code once the process has ended and its output is drained. */
  readonly exited: Promise<number | null>;
  /** Everything the process has written to stdout and stderr so far. */
  output(): string;
  /** SIGTERM, escalating to SIGKILL after 5 s; resolves once the process is gone. */
  stop(): Promise<void>;
}

/** How an HTTP start ended: the transport came up, or the process exited first. */
export type HttpStartup = { kind: 'listening' } | { kind: 'exited'; code: number | null };

/** A port that was free on 127.0.0.1 a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('Could not read the probe port.')),
      );
    });
  });
}

/** The HTTP transport variables pinning the server to `port` on 127.0.0.1, with no port ladder. */
export function httpEnv(port: number): Record<string, string> {
  return {
    MCP_TRANSPORT_TYPE: 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_MAX_PORT_RETRIES: '0',
  };
}

/**
 * Spawns the server with `env` over a scrubbed copy of the parent environment.
 * Records and logs land under `workDir`, which is also the process's cwd. An
 * `undefined` value leaves that variable unset.
 */
export function launchServer(
  workDir: string,
  env: Record<string, string | undefined>,
): ServerProcess {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(MCP|EVALS)_/.test(key)),
  );
  const overrides = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const child = spawn('bun', [SERVER_ENTRY], {
    cwd: workDir,
    env: {
      ...inherited,
      EVALS_DATA_DIR: join(workDir, 'data'),
      LOGS_DIR: join(workDir, 'logs'),
      MCP_LOG_LEVEL: 'error',
      ...overrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
  });

  return {
    child,
    exited,
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const escalate = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(escalate);
    },
  };
}

/** Polls `/healthz` until the transport answers, or reports the exit if the process ends first. */
export async function awaitHttpStartup(server: ServerProcess, port: number): Promise<HttpStartup> {
  const exit = server.exited.then((code): HttpStartup => ({ kind: 'exited', code }));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const probe = fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    }).then(
      (response): HttpStartup | undefined => (response.ok ? { kind: 'listening' } : undefined),
      () => undefined,
    );
    const outcome = await Promise.race([exit, probe]);
    if (outcome) return outcome;
    await delay(100);
  }
  throw new Error(
    `Server neither listened on port ${port} nor exited within 15 s. Output:\n${server.output()}`,
  );
}
