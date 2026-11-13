<div align="center">
  <h1>@cyanheads/evals-mcp-server</h1>
  <p><b>Author verifiable eval records through a draft → review → revise → submit loop with server-enforced graders; compile to JSONL/CSV/Inspect/lm-eval via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Record Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/evals-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/evals-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/evals-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/evals-mcp-server/releases/latest/download/evals-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=evals-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXZhbHMtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22evals-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fevals-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Build verifiable eval records with server-enforced graders. Draft a record with its own executable grader, revise it field by field, and submit through a gate that requires the gold and positive answers to pass, all negative cases to fail, and an independent check to agree. Export to JSONL, CSV, Inspect AI, or lm-evaluation-harness.

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
| `eval://record/{id}` | The modeled fields of a draft or submitted record by id, for resource-capable clients. |

All record data is also reachable through the tool surface — `evals_get_record` for a single record, `evals_list_records` to browse. The resource is a convenience mirror for clients that support resources, not the access path.

### Skill

The [evals-guide](./skills/evals-guide/SKILL.md) covers independent verification, submission blockers, corpus coverage, and downstream scoring. It ships with plugin, npm, Docker, and MCPB installs and is available over MCP at `skill://evals-guide/SKILL.md`.

## Capability reference

### `evals_describe_schema` <sub>tool</sub>

- Accepts `task_type`: `numeric`, `exact_answer`, `set_answer`, `mcq`, `regex_answer`, `json_answer`, or `free_response`.
- Returns the gold shape, grader kinds, required/optional fields, and authoring notes from static schemas; `mcq` requires `choices`, and `free_response` requires `llm_rubric`.

---

### `evals_create_draft` <sub>tool</sub>

- Accepts a record with its grader and discrimination cases, plus optional `verification` and `captures` (EvalsIDs); `mcq` requires `choices`, and `free_response` requires `llm_rubric`.
- Saves the record as a `draft` once its grader runs, and returns the normalized record, a review protocol, a verification-subagent prompt, and what submit still needs. A draft whose gold fails its grader is still saved.
- Readiness covers the record's grading, evidence, and decorrelation checks. Submit still resolves captures, checks duplicates, and handles optional confirmation.
- Typed errors: `grader_unexecutable`, `task_type_constraint`, `mcq_choice_mismatch`.

---

### `evals_get_record` <sub>tool</sub>

- Reads a draft or submitted record by `id`, which stays stable across submit. Use the generated id from an authoring response or `evals_list_records`.
- Returns the full grader, discrimination cases, and verification evidence; `not_found` points to `evals_list_records`. An invalid stored record reports `record_invalid` with its id and affected field paths.

---

### `evals_revise_draft` <sub>tool</sub>

- Applies `set`, `append`, and `unset` by dotted path to a draft; `task_type` and server-owned fields, including the entire `captured_outputs` subtree, cannot be changed. Arrays are replaced whole or appended, not edited by index.
- Re-validates the record and grader before writing, then returns the record plus `changed` entries (`op`, `path`, `before`, `after`). An unknown path rejects the whole patch.
- Typed errors: `not_found`, `record_frozen` for a submitted id, `invalid_patch_path`, `grader_unexecutable`, `task_type_constraint`, `mcq_choice_mismatch`.

---

### `evals_discard_draft` <sub>tool</sub>

- Deletes a draft by `draft_id` and returns `discarded: true`, including a corrupt draft that cannot be read or revised.
- A submitted record reports `record_frozen`; a missing or already discarded id reports `not_found`.

---

### `evals_run_check` <sub>tool</sub>

- Runs a grader against one or more `candidates` without a saved record; supply `gold` for `exact_match`, while target-embedding kinds such as `numeric` and `mcq` ignore it.
- Returns PASS/REJECT, `detail`, and the `resolved` reference per candidate. `llm_rubric` can't be run here.
- Numeric grading accepts only finite real values; unit-bearing, complex, nonfinite, and non-scalar candidates are rejected. `units` is documentation only.
- Numeric tolerances and rubric weights must be nonnegative; rubric thresholds must be between 0 and 1, with at least one positive effective criterion weight. Zero-weight diagnostic criteria may accompany scored criteria.
- `exact_match` and `set_match` accept normalization operations. `strip_punct` replaces ASCII punctuation with spaces; `remove_punct` deletes it. `strip_latex` handles nested command arguments. Set strings split on commas and newlines by default; select `comma` or `newline` explicitly to keep the other delimiter inside an element.
- Synchronous JSON Schema grading supports draft-07 by default and explicit 2019-09 or 2020-12 dialects. Ignored keyword or format diagnostics appear in each verdict's `detail` without changing the verdict.
- Typed errors: `grader_unexecutable`, `mcq_choice_mismatch`.

---

### `evals_submit_draft` <sub>tool</sub>

- Finalizes by `draft_id`. Every draft needs a declared negative and decorrelated verification. Deterministic graders must pass the gold and every positive and reject every negative. Failed deterministic evidence blocks submission even without a computed value. Also resolves `captures` afresh against `EVALS_CAPTURE_DIR`, rejects duplicate `content_hash`, and can ask for confirmation via `confirm` or `EVALS_REQUIRE_CONFIRMATION`.
- On success, freezes the record with `submitted_at` and `checksum` and returns `status: submitted`; a refusal leaves the draft intact. `free_response` records skip grader verdicts and carry `server_verified: false`.
- Typed errors: `not_found`, `record_invalid`, `record_frozen`, `verification_incomplete`, `grader_failed_on_gold`, `positive_case_failed`, `verification_disagrees_with_gold`, `missing_negative_case`, `negative_case_passed`, `duplicate`, `decorrelation_violation`, `capture_unresolved`, `submit_declined`.

---

### `evals_list_records` <sub>tool</sub>

- Filters by `status` (draft/submitted), `domain`, `task_type`, or `tag`; `limit` is a positive integer and defaults to 50, and `offset` defaults to 0.
- Returns summaries (id, status, task_type, domain, tags, timestamps), newest-first with id as a tie-breaker, plus `shown`, `cap`, `totalCount`, and `truncated`. Pass `nextOffset` as `offset` until it is absent.
- Invalid record files are skipped with a diagnostic notice; valid records remain available.

---

### `evals_export_records` <sub>tool</sub>

- Exports `submitted` records, optionally filtered by `domain`, `task_type`, or `tag`, as `jsonl` (lossless), `csv` (lossy summary), `inspect` (Inspect AI sample array), or `lm-eval` (data manifest for a harness adapter).
- Inspect samples put context before the prompt and use Inspect choice labels (A–Z, then 1, 2, …) for multiple-choice targets. Other gold values become strings, with structured values encoded as JSON. `grader_spec` retains the grading contract; optional scorer hints do not replace it or configure an Inspect task automatically.
- The lm-eval manifest preserves context, choices, and `grader_spec`; it requires a task adapter. Only compatible built-in metric hints are included.
- Writes under `exports/` and returns the path, record count, byte size, and preview. Invalid record files are skipped with a diagnostic notice.

---

### `eval://record/{id}` <sub>resource</sub>

- Reads `id` from `evals_list_records` or a draft/submit response.
- Returns the record's modeled fields as `application/json`, or `not_found` when no record matches. Use `evals_get_record` or JSONL export to retain extension fields in hand-edited files. Invalid stored records report `record_invalid`.
- Resource discovery lists all valid records; skipped invalid files are logged on the server.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Eval authoring:

- A `draft → review → surgical-revise → submit` loop, with the server both storing records and running each record's own grader to reject what doesn't hold up
- Seven task types: `numeric`, `exact_answer`, `set_answer`, `mcq`, `regex_answer`, `json_answer`, `free_response`
- A grader serialized with each record; deterministic kinds (`numeric` via math.js, `exact_match`, `set_match`, `regex`, `mcq`, `json_match`) run server-side, while `llm_rubric` relies on recorded independent verification
- A submit gate: the gold and every positive must pass their grader, at least one negative is required and all must be rejected, and a recorded decorrelated verification must agree with the gold
- Plain JSON files under `EVALS_DATA_DIR`, with drafts, submitted records, and exports kept separate

Agent-friendly output:

- `evals_create_draft` and `evals_revise_draft` return the parsed record, a per-field review protocol, and a ready-to-paste verification-subagent prompt
- Draft and revise responses report pass/reject results for each positive and negative case
- `evals_list_records` reports page counts and `nextOffset` to continue browsing
- The submit gate fails with a typed `reason` plus a recovery hint

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

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).
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
| `EVALS_CAPTURE_DIR` | Directory of tool-call capture files read at submit. The reader is available; automatic framework capture production is pending [mcp-ts-core#247](https://github.com/cyanheads/mcp-ts-core/issues/247). | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`; `stateless` is refused because submit confirmation needs a live session. | `stateful` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

Use an absolute `LOGS_DIR` to select a log directory outside the server's installation. For JWT deployments, set `MCP_JWT_EXPECTED_AUDIENCE` and, if applicable, `MCP_JWT_EXPECTED_ISSUER`. If a refreshed token changes the tenant, client ID, or subject, initialize a new HTTP session.

Submit confirmation expires after 10 minutes and must be repeated if the draft changes. When running more than one instance, use shared storage (`STORAGE_PROVIDER_TYPE=filesystem` with a shared `STORAGE_FILESYSTEM_PATH`, `supabase`, or `cloudflare-d1`; not `cloudflare-kv`) and set the same `MCP_REQUEST_STATE_KEY` (at least 32 bytes) on each.

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
