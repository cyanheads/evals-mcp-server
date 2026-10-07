<div align="center">
  <h1>@cyanheads/evals-mcp-server</h1>
  <p><b>Author verifiable eval records through a draft → review → revise → submit loop with server-enforced graders; compile to JSONL/CSV/Inspect/lm-eval via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/evals-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/evals-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/evals-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/evals-mcp-server/releases/latest/download/evals-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=evals-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXZhbHMtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22evals-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fevals-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Verifiable eval records, authored through a draft → review → surgical-revise → submit loop with server-enforced graders. Create a draft carrying its own executable grader, patch it surgically field by field, and submit through a committability gate that requires the gold to pass, a declared negative case to fail, and an independent verification to agree — then compile submitted records to JSONL, CSV, Inspect AI, or lm-evaluation-harness. Runs as a stdio process or a local Streamable HTTP server.

### Tools

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

### Resources

| Resource | Description |
|:---|:---|
| `eval://record/{id}` | A single draft or submitted record by id — the same payload `evals_get_record` returns, for resource-capable clients. |

All record data is also reachable through the tool surface — `evals_get_record` for a single record, `evals_list_records` to browse. The resource is a convenience mirror for clients that support resources, not the access path.

## Capability reference

### `evals_describe_schema` <sub>tool</sub>

- Accepts `task_type`: `numeric`, `exact_answer`, `set_answer`, `mcq`, `regex_answer`, `json_answer`, or `free_response`.
- Returns the gold shape, grader kinds, required/optional fields, and authoring notes from static schemas; `mcq` requires `choices`, and `free_response` requires `llm_rubric`.

---

### `evals_create_draft` <sub>tool</sub>

- Accepts a record with its grader and discrimination cases, plus optional `verification` and `captures` (EvalsIDs); `mcq` requires `choices`, and `free_response` requires `llm_rubric`.
- Persists as `draft` and returns the normalized record, review protocol, verification-subagent prompt, and remaining submit requirements. Self-consistency checks `gold` and positives for PASS and negatives for REJECT; independent verification is still required before submit.
- Typed errors: `grader_unexecutable`, `task_type_constraint`, `mcq_choice_mismatch`.

---

### `evals_get_record` <sub>tool</sub>

- Reads a draft or submitted record by `id`, which stays stable across submit.
- Returns the full grader, discrimination cases, and verification evidence; `not_found` points to `evals_list_records`.

---

### `evals_revise_draft` <sub>tool</sub>

- Applies `set`, `append`, and `unset` by dotted path to a draft; `task_type` and server-owned fields cannot be changed.
- Re-validates the record and task-type constraints, re-runs self-consistency, and returns the record plus `changed` entries (`op`, `path`, `before`, `after`).
- Typed errors: `not_found`, `record_frozen` for a submitted id, `invalid_patch_path`, `task_type_constraint`, `mcq_choice_mismatch`.

---

### `evals_discard_draft` <sub>tool</sub>

- Deletes a draft by `draft_id` and returns `discarded: true`.
- A submitted record reports `record_frozen`; a missing or already discarded id reports `not_found`.

---

### `evals_run_check` <sub>tool</sub>

- Runs a grader against one or more `candidates` without a saved record; supply `gold` for `exact_match`, while target-embedding kinds such as `numeric` and `mcq` ignore it.
- Returns PASS/REJECT, `detail`, and the `resolved` reference per candidate. `llm_rubric` is unexecutable here; submit relies on recorded independent verification.
- Typed errors: `grader_unexecutable`, `mcq_choice_mismatch`.

---

### `evals_submit_draft` <sub>tool</sub>

- Finalizes by `draft_id`: gold must PASS, ≥1 negative must be REJECTED, and decorrelated verification must agree. Embeds and cross-checks `captures` from `EVALS_CAPTURE_DIR`, rejects duplicate `content_hash`, and optionally asks for confirmation via `confirm` or `EVALS_REQUIRE_CONFIRMATION`.
- On success, freezes the record with `submitted_at` and `checksum` and returns `status: submitted`; a refusal leaves the draft intact. `free_response` relies on recorded verification alone with `server_verified: false`.
- Typed errors: `not_found`, `record_frozen`, `verification_incomplete`, `grader_failed_on_gold`, `verification_disagrees_with_gold`, `missing_negative_case`, `negative_case_passed`, `duplicate`, `decorrelation_violation`, `capture_unresolved`, `submit_declined`.

---

### `evals_list_records` <sub>tool</sub>

- Filters by `status` (draft/submitted), `domain`, `task_type`, or `tag`; `limit` defaults to 50 and allows up to 500.
- Returns summaries (id, status, task_type, domain, tags, timestamps), newest-first, with `shown`, `cap`, `totalCount`, and `truncated`.

---

### `evals_export_records` <sub>tool</sub>

- Exports `submitted` records, optionally filtered by `domain`, `task_type`, or `tag`, as `jsonl` (lossless), `csv` (lossy summary), `inspect` (Inspect AI), or `lm-eval` (lm-evaluation-harness).
- Writes under `exports/` and returns the path, record count, byte size, and preview.

---

### `eval://record/{id}` <sub>resource</sub>

- Reads `id` from `evals_list_records` or a draft/submit response.
- Returns the `evals_get_record` payload as `application/json`, or `not_found` when no record matches.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Eval authoring:

- A `draft → review → surgical-revise → submit` loop, with the server acting as both scribe (normalize, persist, compile) and adversarial checker (runs the record's own grader, rejects what doesn't hold up)
- Records are a Zod `discriminatedUnion` on `task_type` — `numeric`, `exact_answer`, `set_answer`, `mcq`, `regex_answer`, `json_answer`, `free_response`
- A typed grader DSL serialized with each record — deterministic kinds (`numeric` via math.js, `exact_match`, `set_match`, `regex`, `mcq`, `json_match`) run server-side; `llm_rubric` relies on recorded independent verification
- An enforced committability gate at submit: the gold must pass its own grader, ≥1 negative must be rejected, and a recorded decorrelated verification must agree with the gold
- Optional confirmation expires after 10 minutes, binds the caller and complete draft, and must be repeated if the draft changes
- Plain JSON files under `EVALS_DATA_DIR` — inspectable, diffable, version-controllable records, with drafts, submitted records, and exports kept separate

Agent-friendly output:

- Instructional responses — `evals_create_draft` and `evals_revise_draft` return the parsed record parroted back, a per-field review protocol, and a ready-to-paste verification-subagent prompt
- Self-consistency verdicts — every draft/revise response reports per-positive and per-negative pass/reject results, not just a boolean
- Truncation disclosure — `evals_list_records` reports `shown` / `cap` / total count when the limit is hit, so a partial set is never mistaken for the whole corpus
- Typed refusal — the submit gate fails with a typed `reason` plus a recovery hint, so a rejected record tells the agent exactly what to fix

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
        "-v", "evals-data:/usr/src/app/evals-data",
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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `EVALS_REQUIRE_CONFIRMATION` | When `true`, `evals_submit_draft` requests human confirmation through multi-round input before finalizing. | `false` |
| `EVALS_DEFAULT_LICENSE` | Default `metadata.license` applied when a draft omits one (e.g. `CC-BY-4.0`). | — |
| `EVALS_CAPTURE_DIR` | Directory of framework-written tool-call captures; when set, `captures` EvalsIDs resolve to full dumps. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless` (`auto` resolves to `stateful`). A `stateless` HTTP start is refused, since a 2025-era client can answer the `evals_submit_draft` confirmation only over a live session. No effect on stdio. | `stateful` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

Confirmation records use framework storage separately from the eval JSON store. For deployments where a retry can reach another instance, configure `STORAGE_PROVIDER_TYPE=filesystem` with a shared `STORAGE_FILESYSTEM_PATH`, or use `supabase` or `cloudflare-d1`; `cloudflare-kv` is unsuitable for consent because reads and deletes are eventually consistent. Set the same `MCP_REQUEST_STATE_KEY` (at least 32 bytes) on each instance to seal round-trip state. Consent redemption blocks sequential replay; concurrent retries still require serialization because framework storage has no atomic read-and-delete.

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
docker run --rm -e MCP_TRANSPORT_TYPE=stdio -v evals-data:/usr/src/app/evals-data evals-mcp-server
```

The Dockerfile defaults to HTTP transport, stateful session mode, and logs to `/var/log/evals-mcp-server`. Mount record storage at `/usr/src/app/evals-data`, the default directory owned by the runtime user. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
