/**
 * @fileoverview The 2025-era Streamable HTTP leg of evals_submit_draft's
 * confirmation gate. Boots the real server over HTTP — under the shipped
 * MCP_SESSION_MODE=stateful and with the variable unset — and drives it as a
 * 2025-11-25 client declaring form elicitation, over raw JSON-RPC rather than an
 * SDK client, so the protocol revision is pinned and every assertion is on what
 * crosses the wire: the advertised session mode, the session handshake, the
 * server's `elicitation/create` request, and the tool result an accept or a
 * decline produces.
 * @module tests/integration/submit-confirmation-http.int.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  awaitHttpStartup,
  freePort,
  httpEnv,
  launchServer,
  type ServerProcess,
} from './helpers/server-process.js';

const PROTOCOL_VERSION = '2025-11-25';
const SESSION_MODE_META_KEY = 'io.github.cyanheads.mcp-ts-core/sessionMode';
const JSON_RPC_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};

interface JsonRpcMessage {
  error?: { code: number; message: string };
  id?: number | string;
  jsonrpc: '2.0';
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface ToolResult {
  content: Array<{ text?: string; type: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** What the client answers an `elicitation/create` with. */
type ElicitAnswer =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' | 'cancel' };

/** One `tools/call` exchange as observed on the wire. */
interface ToolExchange {
  /** HTTP status of each POST that carried a response to a server request. */
  answerStatuses: number[];
  result: ToolResult;
  /** Server→client requests that arrived on the call's stream, in order. */
  serverRequests: JsonRpcMessage[];
}

/** Yields each JSON-RPC message of an SSE response body as its event completes. */
async function* sseMessages(response: Response): AsyncGenerator<JsonRpcMessage> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    throw new Error(`Expected an SSE response, got ${response.status} "${contentType}".`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        const data = buffered
          .slice(0, boundary)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        buffered = buffered.slice(boundary + 2);
        if (data.startsWith('{')) yield JSON.parse(data) as JsonRpcMessage;
        boundary = buffered.indexOf('\n\n');
      }
    }
  } finally {
    // A caller that stops at its response releases the connection rather than leaving it open.
    await reader.cancel();
  }
}

/** The message on `response`'s stream answering request `id`. */
async function responseTo(response: Response, id: number): Promise<JsonRpcMessage> {
  for await (const message of sseMessages(response)) {
    if (message.id === id && !message.method) return message;
  }
  throw new Error(`The stream ended without a response to request ${id}.`);
}

/** Opens a 2025-11-25 session whose client declares form elicitation. */
async function openSession(endpoint: string) {
  const init = await fetch(endpoint, {
    method: 'POST',
    headers: JSON_RPC_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: 'submit-confirmation-test', version: '1.0.0' },
      },
    }),
  });
  const sessionId = init.headers.get('mcp-session-id');
  const initialized = await responseTo(init, 0);
  const headers = {
    ...JSON_RPC_HEADERS,
    'Mcp-Session-Id': sessionId ?? '',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  const post = (message: Omit<JsonRpcMessage, 'jsonrpc'>) =>
    fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });
  const acknowledged = await post({ method: 'notifications/initialized' });
  let nextId = 1;

  /**
   * Calls a tool and follows its stream to the result, answering each
   * server→client request with `answer`. A request with no `answer` fails the call.
   */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    answer?: (request: JsonRpcMessage) => ElicitAnswer,
  ): Promise<ToolExchange> {
    const id = nextId++;
    const response = await post({ id, method: 'tools/call', params: { name, arguments: args } });
    const serverRequests: JsonRpcMessage[] = [];
    const answerStatuses: number[] = [];
    for await (const message of sseMessages(response)) {
      if (message.method && message.id !== undefined) {
        serverRequests.push(message);
        if (!answer) throw new Error(`Unexpected server request during ${name}: ${message.method}`);
        const reply = await post({ id: message.id, result: { ...answer(message) } });
        answerStatuses.push(reply.status);
        continue;
      }
      if (message.id === id) {
        return { answerStatuses, result: message.result as unknown as ToolResult, serverRequests };
      }
    }
    throw new Error(`tools/call ${name} (id ${id}) ended without a response.`);
  }

  return { acknowledged: acknowledged.status, callTool, initialized, sessionId };
}

type Session = Awaited<ReturnType<typeof openSession>>;

/** Creates a draft that clears the submit gate; `prompt` keeps its content hash unique. */
async function createReadyDraft(session: Session, prompt: string): Promise<string> {
  const { result } = await session.callTool('evals_create_draft', {
    task_type: 'numeric',
    prompt,
    gold: '5/14',
    grader: { kind: 'numeric', target: '5/14', rel_tol: 1e-3 },
    discrimination: { positive: ['10/28'], negative: ['25/64'] },
    metadata: { domain: 'math.probability', tags: ['combinatorics'] },
    verification: {
      method: 'independent_derivation',
      evidence: [{ type: 'note', text: 'Re-derived as C(5,2)/C(8,2) before submitting.' }],
    },
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    status: 'draft',
    server_checks: { self_consistency: { ready_to_submit: true } },
  });
  return result.structuredContent?.draft_id as string;
}

/** The record's status as `evals_get_record` reports it. */
async function recordStatus(session: Session, id: string): Promise<unknown> {
  const { result } = await session.callTool('evals_get_record', { id });
  return (result.structuredContent?.record as { status?: unknown } | undefined)?.status;
}

describe.each([
  ['the shipped MCP_SESSION_MODE=stateful', 'stateful'],
  ['MCP_SESSION_MODE unset', undefined],
])('evals_submit_draft confirmation over 2025-era HTTP — %s', (_label, sessionMode) => {
  let workDir: string;
  let server: ServerProcess;
  let base: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'evals-confirm-http-'));
    const port = await freePort();
    server = launchServer(workDir, { ...httpEnv(port), MCP_SESSION_MODE: sessionMode });
    expect(await awaitHttpStartup(server, port), server.output()).toEqual({ kind: 'listening' });
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server?.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it('advertises stateful on the GET /mcp status and the server card', async () => {
    const status = (await (await fetch(`${base}/mcp`)).json()) as {
      server: { sessionMode: string };
    };
    const card = (await (await fetch(`${base}/.well-known/mcp.json`)).json()) as {
      _meta: Record<string, unknown>;
    };

    expect(status.server.sessionMode).toBe('stateful');
    expect(card._meta[SESSION_MODE_META_KEY]).toBe('stateful');
  });

  it('opens a 2025-11-25 session', async () => {
    const session = await openSession(`${base}/mcp`);

    expect(session.initialized.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'evals-mcp-server' },
    });
    expect(session.sessionId).toEqual(expect.stringMatching(/\S/));
    expect(session.acknowledged).toBe(202);
  });

  it('sends elicitation/create for confirm: true and submits on accept', async () => {
    const session = await openSession(`${base}/mcp`);
    const draftId = await createReadyDraft(
      session,
      'P(both red), 5 red + 3 blue, no replacement — accept',
    );

    const exchange = await session.callTool(
      'evals_submit_draft',
      { draft_id: draftId, confirm: true },
      () => ({ action: 'accept', content: { confirm: true } }),
    );

    expect(exchange.serverRequests).toHaveLength(1);
    expect(exchange.serverRequests[0]).toMatchObject({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: expect.stringContaining(draftId),
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean' } },
          required: ['confirm'],
        },
      },
    });
    expect(exchange.answerStatuses).toEqual([202]);
    expect(exchange.result.isError).toBeFalsy();
    expect(exchange.result.structuredContent).toMatchObject({
      id: draftId,
      status: 'submitted',
      frozen: true,
      grader_run: { gold: 'PASS', server_verified: true },
    });
    expect(exchange.result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(`${draftId} is now submitted`),
        }),
      ]),
    );
    expect(await recordStatus(session, draftId)).toBe('submitted');
  });

  it('answers a decline with submit_declined and leaves the record a draft', async () => {
    const session = await openSession(`${base}/mcp`);
    const draftId = await createReadyDraft(
      session,
      'P(both red), 5 red + 3 blue, no replacement — decline',
    );

    const exchange = await session.callTool(
      'evals_submit_draft',
      { draft_id: draftId, confirm: true },
      () => ({ action: 'decline' }),
    );

    expect(exchange.serverRequests.map((request) => request.method)).toEqual([
      'elicitation/create',
    ]);
    expect(exchange.answerStatuses).toEqual([202]);
    expect(exchange.result.isError).toBe(true);
    expect(exchange.result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: {
          reason: 'submit_declined',
          recovery: { hint: expect.stringContaining('accept the confirmation') },
        },
      },
    });
    expect(exchange.result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('accept the confirmation'),
        }),
      ]),
    );
    expect(await recordStatus(session, draftId)).toBe('draft');
  });
});
