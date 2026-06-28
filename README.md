<div align="center">
  <h1>@cyanheads/evals-mcp-server</h1>
  <p><b>Author verifiable eval records through a draft → review → revise → submit loop with server-enforced graders; compile to JSONL/CSV/Inspect/lm-eval via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/evals-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/evals-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/evals-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/evals-mcp-server/releases/latest/download/evals-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=evals-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXZhbHMtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22evals-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fevals-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Nine tools for authoring eval records — the draft loop (create, revise, discard, submit), the standalone deterministic checker, and read/list/export:

| Tool | Description |
|:---|:---|
| `evals_describe_schema` | Return the required and optional fields plus grader options for a task type. Call before drafting. |
| `evals_create_draft` | Create a draft eval record carrying its own grader; returns the parsed record, a review protocol, and a verification subagent prompt. |
| `evals_get_record` | Read a draft or submitted record by id; the id is stable across submit. |
| `evals_revise_draft` | Apply a surgical `set` / `append` / `unset` patch to a draft by dotted path; re-runs the self-consistency check. |
| `evals_discard_draft` | Delete a draft record by id. Draft-only. |
| `evals_run_check` | Run a grader spec against candidate answers and get PASS/REJECT per candidate, decoupled from any saved record. |
| `evals_submit_draft` | Finalize a draft through the committability gate, then freeze it. |
| `evals_list_records` | Browse and filter records by status, domain, task type, or tag. Returns a compact summary per record. |
| `evals_export_records` | Compile submitted records to JSONL, CSV, Inspect AI, or lm-evaluation-harness and write the artifact under `exports/`. |

### `evals_describe_schema`

Return what a record of a given `task_type` needs before you draft it.

- Static — derived from the record and grader Zod schemas, no disk or runtime state
- Per-type gold shape, appropriate grader kind(s), required/optional fields, and authoring notes
- `task_type` is one of `numeric`, `exact_answer`, `set_answer`, `mcq`, `regex_answer`, `json_answer`, `free_response`

---

### `evals_create_draft`

Create and persist a draft eval record, then reflect it back as a review forcing function.

- Validates against the `task_type` discriminated union (per-type rules: `mcq` requires `choices`; `free_response` requires an `llm_rubric` grader)
- Runs a cheap self-consistency check — grader vs gold and each positive must PASS, vs each negative must REJECT
- Returns the normalized record parroted back behind a divider, a per-field review protocol, a ready-to-paste verification subagent prompt, and what's still required before submit
- Optional draft-time `verification` block and `captures` (EvalsIDs) when you already hold provenance
- Stays `draft` — passing self-consistency proves the grader discriminates, not that the gold is right

---

### `evals_revise_draft`

Surgically patch a draft so each change stays legible.

- Explicit `set` (dotted-path → value), `append` (dotted-path → array items), and `unset` (dotted paths) operations — not full-record rewrites
- Returns the updated record, an itemized list of what changed, and a re-run self-consistency verdict
- Re-validates the full shape and cross-field constraints after the patch
- Draft-only — submitted records are frozen; `task_type` cannot be patched (start a new draft to change the discriminant)

---

### `evals_run_check`

Run a grader against one or more candidates without touching a saved record.

- PASS/REJECT per candidate plus the resolved comparison value (e.g. the math.js-evaluated numeric target), so you see why each matched or missed
- `candidates` accepts strings, numbers, objects, or arrays — whatever the grader kind expects
- Supply `gold` for gold-relative kinds (`exact_match`); it is a no-op for target-embedding kinds like `numeric` and `mcq`
- `llm_rubric` cannot run here — it is graded at submit via sampling

---

### `evals_submit_draft`

Finalize a draft through the committability gate, then freeze it.

- The gate runs the grader against the gold (must PASS), requires ≥1 declared negative case to be REJECTED, and requires a recorded, decorrelated independent verification that agrees with the gold
- Resolves and embeds any `captures` from `EVALS_CAPTURE_DIR`, cross-checking the gold against the authoritative captured value
- Rejects duplicates (same `content_hash` already submitted)
- On pass, flips the record to `submitted`, stamps `submitted_at` and a `checksum`, and freezes it; otherwise refuses with a typed error and the record stays a draft
- `free_response` `llm_rubric` is judged via sampling when the client supports it, else admitted on recorded verification alone and flagged `server_verified: false`

---

### `evals_export_records`

Compile submitted records to a downstream eval format.

- `jsonl` (lossless, the lingua franca), `csv` (a flattened, lossy spreadsheet summary), `inspect` (UK AISI Inspect AI), `lm-eval` (EleutherAI lm-evaluation-harness)
- Optional `domain` / `task_type` / `tag` filter
- Only submitted records are exported — drafts are skipped
- Writes the artifact under `exports/` and returns the file path, record count, byte size, and a short preview instead of dumping inline

## Resource

| Type | Name | Description |
|:---|:---|:---|
| Resource | `eval://record/{id}` | A single draft or submitted record by id — the same payload `evals_get_record` returns, for resource-capable clients. |

All record data is also reachable through the tool surface — `evals_get_record` for a single record, `evals_list_records` to browse. The resource is a convenience mirror for clients that support resources, not the access path.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Typed error contracts — tools declare their domain failures (`reason` + recovery), surfaced to the agent
- Pluggable auth: `none`, `jwt`, `oauth`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Eval authoring:

- A `draft → review → surgical-revise → submit` loop, with the server acting as both scribe (normalize, persist, compile) and adversarial checker (run the record's own grader, reject what doesn't hold up)
- Records are a Zod `discriminatedUnion` keyed on `task_type` — `numeric`, `exact_answer`, `set_answer`, `mcq`, `regex_answer`, `json_answer`, `free_response`
- A typed grader DSL serialized with each record — deterministic kinds (`numeric` via math.js, `exact_match`, `set_match`, `regex`, `mcq`, `json_match`) run server-side; `llm_rubric` routes to sampling
- An enforced committability gate at submit: the gold must pass its own grader, ≥1 negative must be rejected, and a recorded decorrelated verification must agree with the gold
- Optional fleet grounding via the `captures` EvalsID field — link framework-written tool-call dumps, resolved from `EVALS_CAPTURE_DIR` and cross-checked against the gold (no server-to-server calls)
- Plain JSON files under `EVALS_DATA_DIR` — inspectable, diffable, version-controllable records
- Compile to JSONL, CSV, Inspect AI, and lm-evaluation-harness formats

Agent-friendly output:

- The two instructional tools (`evals_create_draft`, `evals_revise_draft`) carry the loop's review mechanism in their responses — the parsed record parroted back, a per-field review protocol, and a ready subagent prompt
- Self-consistency verdicts on every draft and revise — per-positive and per-negative results, not just a boolean
- `evals_list_records` discloses truncation when the limit is hit, so a partial set is never mistaken for the whole corpus
- The submit gate refuses with a typed `reason` + recovery hint, so a rejected record tells the agent exactly what to fix

## Getting started

Add the following to your MCP client configuration file. Set `EVALS_DATA_DIR` to a writable folder — the server manages `drafts/`, `submitted/`, and `exports/` under it.

```json
{
  "mcpServers": {
    "evals-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/evals-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "EVALS_DATA_DIR": "/absolute/path/to/evals-data"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "evals-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/evals-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "EVALS_DATA_DIR": "/absolute/path/to/evals-data"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "evals-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "EVALS_DATA_DIR=/data",
        "-v", "evals-data:/data",
        "ghcr.io/cyanheads/evals-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 EVALS_DATA_DIR=./evals-data bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
- A writable directory for `EVALS_DATA_DIR`. No external API key is required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/evals-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd evals-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set EVALS_DATA_DIR
```

## Configuration

All server configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---|:---|:---|
| `EVALS_DATA_DIR` | Root folder for record JSON; the store manages `drafts/`, `submitted/`, and `exports/` under it. | `./evals-data` |
| `EVALS_REQUIRE_CONFIRMATION` | When `true`, `evals_submit_draft` fires a human-confirmation elicit where the client supports it. | `false` |
| `EVALS_DEFAULT_LICENSE` | Default `metadata.license` applied when a draft omits one (e.g. `CC-BY-4.0`). | — |
| `EVALS_CAPTURE_DIR` | Directory of framework-written tool-call captures; when set, `captures` EvalsIDs resolve to full dumps. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t evals-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=stdio -e EVALS_DATA_DIR=/data -v evals-data:/data evals-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/evals-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and the resource, inits the record-store and exporter services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/eval-record` | The record schema, draft builder, and submit gate. |
| `src/services/grader` | Deterministic grader DSL execution and the committability check. |
| `src/services/record-store` | On-disk JSON record CRUD, the draft→submitted move, and export writes. |
| `src/services/exporter` | Compiling submitted records to JSONL/CSV/Inspect/lm-eval. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; records persist to disk via the `record-store` service, not `ctx.state`
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- The server is the source of truth — validate inputs, run the grader as a hard gate, and never admit a record on assertion alone

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
