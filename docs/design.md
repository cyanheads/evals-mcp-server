# evals-mcp-server — Design

> Implements the **[authoring-loop archetype](./authoring-loop-pattern.md)** — the server is not a data source the agent queries; it is the surface through which the agent *produces a verified artifact*, acting as both **scribe** (normalize, persist, compile) and **adversarial checker** (run the record's own grader, reject what doesn't hold up). Full concept + rationale: [`idea.md`](./idea.md).

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `evals_describe_schema` | Returns the required and optional fields plus grader options for a given `task_type`. Call before drafting to learn what a record of that type needs. Static — derived from the Zod schemas, no disk or runtime state. | `task_type` (enum) | `readOnlyHint: true`, `openWorldHint: false` |
| `evals_create_draft` | Create a draft eval record. Persists it, then returns the parsed record parroted back behind a divider, a per-field review protocol, a ready-to-paste verification subagent prompt, and the self-consistency check result. Stays `draft` — passing self-consistency proves the grader discriminates, not that the gold is right. | `task_type`, `prompt`, `gold`, `grader`, `discrimination`, `metadata`; optional `context`, `choices`, `captures` (EvalsIDs), `author_model`, `verification` (method + generation_method + evidence[] — if you already have provenance at draft time) | `readOnlyHint: false`, `idempotentHint: false`, `openWorldHint: false` |
| `evals_get_record` | Read a draft or submitted record by id. The id is stable across submit, so it resolves whether the record is still a draft or already submitted. | `id` | `readOnlyHint: true`, `openWorldHint: false` |
| `evals_revise_draft` | Apply a surgical, field-level patch to a `draft` (`set` / `append` / `unset` by dotted path). Returns the updated record, what changed, and a re-run of self-consistency (the grader may have changed). `draft`-only — submitted records are frozen. | `draft_id`, `set?`, `append?`, `unset?` | `readOnlyHint: false`, `idempotentHint: false`, `openWorldHint: false` |
| `evals_discard_draft` | Delete a `draft` record by id. `draft`-only — submitted records are frozen and cannot be discarded. Lets a batch-authoring agent clean up abandoned drafts. | `draft_id` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `evals_run_check` | Standalone deterministic grader. Runs a grader spec against one or more candidate answers and returns PASS/REJECT per candidate. Used mid-loop by the author or subagent to re-derive or spot-check the gold, decoupled from any persisted record. | `grader`, `candidates[]`, `gold?`, `choices?` | `readOnlyHint: true`, `openWorldHint: false` |
| `evals_submit_draft` | Gated finalize. Runs the committability invariant server-side (gold passes its grader; ≥1 negative is rejected; recorded independent verification present) and, on pass, flips the record to `submitted`, stamps `submitted_at` + `checksum`, and freezes it. Refuses with a typed error otherwise. | `draft_id`, `confirm?` | `readOnlyHint: false`, `idempotentHint: true`, `destructiveHint: false`, `openWorldHint: false` |
| `evals_list_records` | Browse and filter records by `status`, `domain`, `task_type`, or `tag`. Returns a summary projection per record (not full records). Discloses truncation when the cap is hit. | `status?`, `domain?`, `task_type?`, `tag?`, `limit?` | `readOnlyHint: true`, `openWorldHint: false` |
| `evals_export_records` | Compile submitted records (all, or by filter) to a downstream format: `jsonl` (lossless), `csv` (flattened, lossy), `inspect` (Inspect AI), `lm-eval` (lm-evaluation-harness). Writes the artifact under `exports/` and returns its path + a preview. | `format` (enum), `domain?`, `task_type?`, `tag?` | `readOnlyHint: false`, `openWorldHint: false` |

Naming follows the framework convention: `evals_` prefix + a uniform `verb_noun` shape — every tool is 3 segments. `_draft` for the mutable authoring ops (`evals_create_draft`, `evals_revise_draft`, `evals_discard_draft`, `evals_submit_draft`), `_record(s)` for read/emit (`evals_get_record`, `evals_list_records`, `evals_export_records`); `evals_describe_schema` and `evals_run_check` complete the set.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `eval://record/{id}` | A single draft or submitted record by id — the same payload `evals_get_record` returns, as injectable context for clients that support resources. The id is stable across submit, so the URI resolves before and after finalize. | n/a (single record) |

Tool coverage: every record is reachable via `evals_get_record` / `evals_list_records`; the resource is a convenience mirror for resource-capable clients, not the access path. (Optional for v1 — the tool surface is self-sufficient without it.)

### Prompts

None. The server's "instructional" surface is delivered through the `evals_create_draft` tool response (parrot-back + review protocol + subagent prompt), not as a client-invokable prompt template — the guidance must be tailored to the just-drafted record's live state, which a static prompt can't do.

## Overview

`evals-mcp-server` turns an agent into an **eval author**. The agent builds verifiable eval records through a **draft → review → surgical-revise → submit** loop: it drafts a record; the server reflects the parsed record back with a per-field review protocol and a ready subagent prompt; a fresh verification subagent independently checks it against live sources; the author applies surgical field-level fixes; and a server-side grader gate admits the record to the corpus only if it is self-consistent and independently verified. Submitted records compile to standard eval formats (JSONL, CSV, Inspect AI, lm-eval-harness).

This is an **internal / server-as-source-of-truth** server — it wraps no external API. The deliverable is a high-stakes structured artifact (an eval record carrying its own executable grader) where "looks plausible" is not good enough, so the loop trades throughput for rigor. It is the first instance of the [authoring-loop archetype](./authoring-loop-pattern.md).

**Audience:** agents (and their humans) producing verifiable eval data and reliable graders — the scarce asset in frontier model work (RLVR, process supervision, contamination-resistant benchmarks).

## Requirements

- **Two persisted states only:** `draft` and `submitted`. The loop's review/revise steps iterate on a `draft`; `evals_submit_draft` is the one transition to `submitted`, after which the record is frozen.
- **Eval record is a Zod `discriminatedUnion` keyed on `task_type`** — each type enforces its own required fields. v1 types: `numeric` · `exact_answer` · `set_answer` · `mcq` · `regex_answer` · `json_answer` · `free_response` (rubric-graded).
- **Grader DSL is a typed union** serialized with the record. Deterministic kinds are executed by the server itself (the agent can't merely *assert* the gold is correct); `llm_rubric` runs via `ctx.sample` when the client supports sampling, else is agent-attested and flagged `server_verified: false`. **As built (v1):** the framework `Context` does not yet expose a sampling surface, so `evals_submit_draft` always takes the no-sampling path for `llm_rubric` — `server_verified: false`, admitted on recorded independent verification alone. The gate's `samplingAvailable` plumbing is in place for when `ctx.sample` lands.
- **The committability invariant**, enforced mechanically at `evals_submit_draft`: a record is submittable only if its declared grader, run server-side against its declared gold, returns PASS *and* at least one declared **negative** case is correctly **REJECTED**. This proves self-consistency (gold passes its own grader; the grader discriminates), not correctness.
- **Correctness is addressed by independent verification**, required and recorded before submit: a fresh subagent's decorrelated review (preferred) or the author's own check by a method different from how the gold was generated. The decorrelation rule: the verification path must differ from the generation path.
- **Fleet as ground-truth via a `source_provenance` evidence field** — gold answers can be grounded in live, authoritative data from sibling fleet servers (e.g. `secedgar`, `gbif`, `openfda`, `pubmed`, `worldbank`). **No server-to-server integration:** the agent/subagent already holds those servers as tools, fetches the value, and passes it into `evals_revise_draft` as an evidence entry (source + query + value + URI + timestamp). The eval server has **no outbound MCP client**.
- **Surgical revision only** — `evals_revise_draft` applies explicit `set` / `append` / `unset` operations by dotted path, not full-record rewrites, so changes stay legible. `draft`-only.
- **Data backing is plain JSON files** under `EVALS_DATA_DIR` — no database. Records are inspectable, diffable, and version-controllable on disk.
- **Subagent verification is recommended, not required.** The server can't detect or force a subagent; it degrades to the author's own decorrelated check. The submit gate still requires *some* recorded independent verification, so the quality floor holds either way — only the strength of decorrelation varies.
- **No auth scopes / no rate limits** — stdio-first, single-tenant by default. For hosted multi-user use, namespace records under a tenant subdir of the data root.

## Data Model

The load-bearing reference for implementation — the record schema and grader DSL drive every tool's input/output shape.

### Eval record (discriminated union on `task_type`)

```ts
type EvalRecord = {
  id: string;                       // ev_<nanoid(10)>, server-assigned, STABLE across submit
  status: "draft" | "submitted";
  task_type: TaskType;              // discriminant
  prompt: string;                   // the task shown to the model under test
  context?: string;                 // optional grounding passage
  gold: unknown;                    // reference answer (shape depends on task_type)
  grader: Grader;                   // executable verifier (below)
  discrimination: {
    positive: unknown[];            // answers that MUST pass (gold is implicitly one)
    negative: unknown[];            // ≥1 known-wrong answer that MUST fail
  };
  choices?: string[];               // required for mcq
  metadata: {
    domain: string;                 // e.g. "math.probability", "finance.filings"
    tags: string[];
    license?: string;               // defaults to EVALS_DEFAULT_LICENSE when omitted
    source_provenance?: Source[];   // citations; live-source verification lands here
    contamination_notes?: string;
  };
  verification: {
    method: string;                 // how gold was checked (e.g. "independent_derivation", "external_source")
    generation_method?: string;     // how the answer was produced (for decorrelation)
    evidence: Evidence[];           // subagent report, tool traces, computed values, source lookups
    attestation?: string;
  };
  captures?: string[];              // agent-supplied EvalsIDs linking the fleet tool calls behind the answer (additive)
  captured_outputs?: Capture[];     // full dumps resolved from EVALS_CAPTURE_DIR, embedded + frozen at submit
  provenance: {
    author_model: string;           // optional caller input; falls back to "unknown"
    created_at: string;             // server-stamped (NOT a caller field)
  };
  content_hash: string;             // set at draft; dedup key (see Identity & integrity)
  submitted_at?: string;            // server-stamped at submit
  checksum?: string;                // set at submit; immutability anchor
};
```

`task_type` per-type required fields: `mcq` requires `choices[]` **and** the grader's `correct` must equal one element of `choices[]`; `free_response` requires a `grader` of kind `llm_rubric`. Deferred task types: `code` (sandbox), `agentic_trajectory`.

### Grader DSL (typed union)

```ts
type Grader =
  | { kind: "numeric"; target: number | string; rel_tol?: number; abs_tol?: number; units?: string } // target: math.js expr
  | { kind: "exact_match"; normalize?: ("trim" | "lowercase" | "strip_punct" | "strip_latex")[] }     // grades vs the record's gold
  | { kind: "set_match"; expected: string[]; order_sensitive?: boolean }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "mcq"; correct: string }                       // must equal one element of choices[]
  | { kind: "json_match"; expected?: unknown; schema?: object }  // at least one of expected/schema required
  | { kind: "llm_rubric"; criteria: Criterion[]; judge_prompt: string; pass_threshold: number }
  // deferred — needs sandbox:
  | { kind: "code_tests"; language: "python" | "javascript"; tests: TestCase[]; entrypoint?: string };
```

- **Target-embedding kinds** (`numeric`, `set_match`, `regex`, `mcq`, `json_match`) carry their reference in the spec; a candidate is graded against that. `numeric` resolves `target` through math.js (so `"5/14"`, `"combinations(5,2)/combinations(8,2)"` are valid).
- **`exact_match` is gold-relative** — it has no embedded target; it grades a candidate against the record's `gold` after applying `normalize`. In `evals_run_check` (no record in scope) supply the reference via the `gold` parameter.
- **`json_match`** — at least one of `expected` or `schema` must be present. `expected` deep-equality checks the candidate; `schema` runs a JSON Schema validation. Both may be supplied (the candidate must satisfy both).
- All non-`llm_rubric` kinds execute deterministically server-side. JSON-Schema-serializable types only — `json_match.expected`/`schema` carry `unknown`/`object`, validated structurally at runtime.

### Sub-types

Referenced by the record above; defined here so the input/output schemas are complete:

```ts
type Source = {                  // an entry in metadata.source_provenance
  server: string;               // fleet server that supplied the value, e.g. "secedgar"
  query: string;                // the call/query made
  value: string;                // the retrieved ground-truth value
  uri?: string;                 // citation / permalink
  retrieved_at: string;         // ISO 8601
};

type Evidence =                  // an entry in verification.evidence (discriminated by `type`)
  | { type: "deterministic_check"; tool: string; claim: string; computed?: unknown; passed: boolean }
  | { type: "subagent_review";    model: string; method?: string; findings: string }
  | { type: "source_lookup";      source: Source }
  | { type: "note";               text: string };

type Criterion = {               // an entry in the llm_rubric grader's `criteria`
  description: string;          // what the judge checks
  weight?: number;              // relative weight (default 1)
};

type Capture = {                 // the fleet tool-call dump, verbatim from EVALS_CAPTURE_DIR/<evals_id>.json (cyanheads/mcp-ts-core#247)
  evals_id: string;             // "<server-prefix>_<shortid>"
  ts: string;                   // ISO 8601 UTC
  server: string;
  serverVersion: string;        // the version that produced the output — reproduction
  tool: string;
  args: unknown;                // validated (post-parse) input
  rawArgs?: unknown;            // input as received, only when it differs from args
  structuredContent: unknown;   // FULL, untruncated output (enrichment already merged in); the { error } envelope on failure
  content?: ContentBlock[];     // the content[] blocks the agent saw (text + any image/audio)
  isError: boolean;
  durationMs?: number;
  traceId?: string;             // OTel span id, when emitted
};
```

`record.rubric` is intentionally **absent** — for `free_response`, the rubric (`criteria` + `judge_prompt` + `pass_threshold`) lives inside the `llm_rubric` grader, so there's one home for it, not two.

### Record identity & integrity

- **`id`** — `ev_<nanoid(10)>` (e.g. `ev_7Qk2mNpXa`), assigned at `evals_create_draft` and **stable across the lifecycle**. `status` distinguishes `draft` from `submitted`; the id never changes, so `evals_get_record` and `eval://record/{id}` resolve a record before and after submit. The file moves `drafts/<id>.json → submitted/<id>.json` on submit; the id stays constant.
- **`content_hash`** — SHA-256 over the *semantic* fields only (`task_type`, `prompt`, `context`, `gold`, `grader`, `choices`), canonicalized with sorted keys. `discrimination` is intentionally excluded — two records with identical task content but different negative cases are not considered duplicates. Computed at draft; drives `evals_submit_draft`'s `duplicate` check (a submitted record with the same `content_hash` already exists → reject).
- **`checksum`** — SHA-256 over the full record JSON with `submitted_at` and `checksum` excluded, keys sorted. Stamped at submit as the immutability anchor.

## Provenance capture (EvalsID)

`Depends on: cyanheads/mcp-ts-core#247.`

The agent is **not** the source of truth for provenance — its retelling is lossy and forgeable, and it never holds the full untruncated tool output. Instead the **framework** captures every fleet tool response server-side, and the eval record links to it by id.

**Mechanism.** Every framework server with `EVALS_CAPTURE_DIR` set writes each tool response's full dump to `$EVALS_CAPTURE_DIR/<evals_id>.json` and injects `evals_id` (= `<server-prefix>_<shortid>`, e.g. `secedgar_a1b2c3d4`) back into the response as a dedicated reserved field — `structuredContent._evals_id`, a `content[]` trailer line, and `_meta["io.cyanheads.mcp-ts-core/evals"]` — **not** through `enrichment` (a per-tool declared contract that strips undeclared keys). The eval server reads from the **same** directory — no server-to-server calls (stdio servers have no listener to dial), no outbound MCP client.

**Flow.**
1. Agent calls a fleet tool → its response carries `structuredContent._evals_id` (also surfaced in `_meta` and a `content[]` trailer line).
2. Agent authors the eval exactly as today (gold, grader, discrimination, …) **and** adds the id(s) to `captures: []`.
3. `evals_revise_draft` / `evals_submit_draft` resolve each id from `EVALS_CAPTURE_DIR`, embed the full dump into `captured_outputs[]` (frozen at submit), lift source URLs into `metadata.source_provenance`, and **cross-check** the authored gold against the captured value.

**Why it matters.** The capture is authoritative and complete — more than the agent ever saw (untruncated) — so the server can flag a hallucinated gold or URL against the real source. Purely additive: the agent still enters everything it does today; the EvalsID is the one new field.

When `EVALS_CAPTURE_DIR` is unset, `captures` ids are stored unresolved (the feature is simply inactive). When it's set and a referenced id has no file, `evals_submit_draft` rejects with `capture_unresolved`. The framework-side write is best-effort (never fails the tool call) and atomic.

## Output Design Notes

The two instructional tools carry the loop's quality mechanism in their responses — both surfaces (`structuredContent` + the `format()` markdown twin) must be content-complete.

- **`evals_create_draft`** — structured fields: `draft_id`, `status`, `normalized_record`, `server_checks`, `review_protocol`, `suggested_subagent_prompt`, `required_before_submit`. The tool takes `author_model` as a **flat top-level optional string** input (not a nested `provenance` object) — the server wraps it into `provenance.author_model` on the stored record; if omitted it falls back to `"unknown"`. `provenance.created_at` is always server-stamped. `format()` parrots the normalized record back field-by-field behind a divider, then renders the review protocol and the ready-to-paste subagent prompt (the subagent calls `evals_get_record`, re-derives/looks up the gold, and reports concisely — one bullet per issue — without mutating the record). See [the worked example](./idea.md#appendix-worked-round-trip) for the exact rendering.
- **`server_checks.self_consistency`** (returned by `evals_create_draft` and `evals_revise_draft`) — shape: `{ gold_passes_grader: boolean, positives_pass: boolean[], negatives_rejected: boolean[], grader_ok: boolean, verification_present: boolean, ready_to_submit: boolean }`. `grader_ok` is `true` when gold + all positives pass and all negatives are rejected. `verification_present` is `true` when at least one `verification.evidence` entry exists (always `false` at initial draft creation). `ready_to_submit` is `true` only when both `grader_ok` and `verification_present` are `true`.
- **`evals_revise_draft`** — returns the updated record; `changed`: an array of `{ op: "set" | "append" | "unset", path, before?, after? }` entries (the legibility mechanism); and the re-run `server_checks.self_consistency`.
- **`evals_submit_draft`** — on success: `id`, `status: "submitted"`, `path`, `checksum`, `grader_run` (gold / positives / negatives verdicts, plus `server_verified`), `verification` (decorrelation source + evidence count), `frozen: true`. On failure: a typed error (below) — the record stays `draft`. **`llm_rubric` without `ctx.sample`:** the server can't run the grader server-side, so it sets `grader_run.server_verified: false` and admits the record on the strength of the recorded independent verification alone (which must be present); steps 1–2 of the gate are skipped, step 3 (recorded verification) is still required.
- **`evals_run_check`** — per-candidate PASS/REJECT plus the resolved comparison value (e.g. the math.js-evaluated `target`), so the caller sees *why* a candidate matched or missed. `candidates` accepts `unknown[]` — strings, numbers, objects, arrays — matching whatever the grader kind expects. `gold` supplies the reference for grader kinds that don't embed a target (`exact_match`); it is ignored for kinds that do. Passing `gold` to a target-embedding kind such as `numeric` or `mcq` is a no-op, not an error.
- **`evals_list_records`** — returns a summary projection per record — `{ id, status, task_type, domain, tags, created_at, submitted_at? }`, not full records (cheaper, and the in-memory filter scans potentially many files). Discloses truncation via `ctx.enrich.truncated({ shown, cap })` when `limit` is hit; silent caps would let the agent treat a partial set as complete. No pagination cursor in v1 — the corpus sizes an authoring workflow produces are small enough for a single capped list; a cursor is deferred alongside the corpus index.
- **`evals_export_records`** — writes the compiled artifact to `$EVALS_DATA_DIR/exports/<timestamp>-<filter>.<ext>` and returns `{ path, format, record_count, bytes, preview }` (`preview` = first ~20 lines/rows). Avoids dumping a multi-MB JSONL inline.
- **`evals_discard_draft`** — returns `{ id, discarded: true }`. A `submitted` id raises `record_frozen`. An id that doesn't exist at all raises `not_found`. The tool is idempotent only in the sense that a draft that has already been discarded (file gone, id unknown) raises `not_found` rather than a distinct "already discarded" error — callers should treat `not_found` on discard as effectively idempotent.

## Error Contract

### `evals_submit_draft` (typed contract — domain failures the agent plans around)

| `reason` | Code | When |
|:---------|:-----|:-----|
| `verification_incomplete` | `InvalidParams` | No recorded independent verification (no subagent report and no author decorrelated check). |
| `grader_failed_on_gold` | `InvalidParams` | The declared grader, run against the declared gold, did not return PASS. |
| `verification_disagrees_with_gold` | `InvalidParams` | A recorded independent verification computed a value that disagrees with the gold (the wrong-gold catch). |
| `missing_negative_case` | `InvalidParams` | `discrimination.negative` is empty — nothing proves the grader rejects a wrong answer. |
| `negative_case_passed` | `InvalidParams` | A declared negative case passed the grader when it should have been rejected (grader accepts everything). |
| `duplicate` | `InvalidParams` | A submitted record with the same `content_hash` already exists. |
| `decorrelation_violation` | `InvalidParams` | The recorded verification path is the same as the generation path (no genuine independence). |
| `capture_unresolved` | `InvalidParams` | A `captures` EvalsID has no file in `EVALS_CAPTURE_DIR`, or it recorded a failed tool call (only when capture is enabled). |
| `submit_declined` | `InvalidParams` | A required human confirmation was declined or cancelled (when `EVALS_REQUIRE_CONFIRMATION` or `confirm` is set and the client supports elicitation). |

All carry recovery guidance in the message (e.g. *"Independent verification computed 0.3571 (5/14) but gold is 25/64 (0.3906). Fix the gold or the grader before submitting."*). Baseline codes (`InternalError`, `ValidationError`, `SerializationError`) bubble freely.

### Other tools

- `evals_get_record` / `evals_revise_draft` / `evals_submit_draft` / `evals_discard_draft` — `not_found` (`NotFound`) for an unknown id.
- `evals_revise_draft` / `evals_discard_draft` — `record_frozen` (`InvalidParams`) when targeting a `submitted` record.
- `evals_revise_draft` — `invalid_patch_path` (`InvalidParams`) when a `set`/`unset` path doesn't resolve against the record shape. `append` targets an array field: a missing *declared-array* path is created, but a path resolving to a non-array throws `invalid_patch_path`. Setting `task_type` via `set` is prohibited (`invalid_patch_path`) — changing the discriminant would invalidate the discriminated-union constraints without re-validating the full record; start a new draft instead.
- `evals_run_check` / `evals_create_draft` — `grader_unexecutable` (`InvalidParams`) when a grader spec can't run (e.g. a malformed math.js `target`, invalid regex, or a `json_match` with neither `expected` nor `schema`) — the message names the offending field.
- `evals_create_draft` / `evals_revise_draft` — `task_type_constraint` (`InvalidParams`) when a per-task-type rule is violated (`mcq` without `choices`; `free_response` without an `llm_rubric` grader), and `mcq_choice_mismatch` (`InvalidParams`) when the `mcq` grader's `correct` is not one of `choices`. `evals_run_check` also raises `mcq_choice_mismatch` when a supplied `mcq` grader's `correct` is not among the passed `choices`.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `record-store` | The on-disk JSON tree (`drafts/`, `submitted/`, `exports/` under `EVALS_DATA_DIR`) — create/read/patch/list/delete, the `drafts/ → submitted/` move with `checksum` + `submitted_at` stamping and freeze, `content_hash` computation, and export-file writes. | every tool |
| `grader` | Deterministic execution of the grader DSL kinds (numeric via math.js, exact/set/regex/mcq/json) → PASS/REJECT, plus the committability check (gold + positives pass, negatives rejected). `llm_rubric` routes to `ctx.sample` when available. | `evals_create_draft`, `evals_revise_draft`, `evals_run_check`, `evals_submit_draft` |
| `exporter` | Compiling submitted records to `jsonl` / `csv` / `inspect` / `lm-eval`; maps the grader DSL to each harness's scoring primitive where one exists, else emits the grader spec inline. | `evals_export_records` |

**Server-as-service:** the server IS the source of truth — no upstream to retry, no resilience/backoff layer. The design questions are state-lifecycle: drafts are mutable until submit, submitted records are frozen; nothing is TTL'd; everything survives restart (it's on disk). Storage is the local filesystem via the `record-store` service, not `ctx.state` — records must be human-inspectable and version-controllable files, which a KV store isn't. (For a hosted multi-tenant deployment, the store namespaces under a per-`tenantId` subdir of the root.)

The only notable runtime dependency is **math.js** (numeric grading), same as `calculator-mcp-server`, plus a small id generator (`nanoid`).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `EVALS_DATA_DIR` | yes | Root folder for record JSON. The store manages `drafts/`, `submitted/`, and `exports/` subdirs under it. |
| `EVALS_REQUIRE_CONFIRMATION` | no (default `false`) | When `true`, `evals_submit_draft` fires `ctx.elicit` for human confirmation where the client supports it. Off by default — per-record human elicit would kill batch authoring; the natural human checkpoint is `evals_export_records`. |
| `EVALS_DEFAULT_LICENSE` | no | Default `metadata.license` applied when a draft omits one. |
| `EVALS_CAPTURE_DIR` | no | Directory of framework-written tool-call captures (see [Provenance capture](#provenance-capture-evalsid)). Set it to the same path the fleet servers write to; when set, `captures` EvalsIDs resolve to full dumps. |

Lives in `src/config/server-config.ts` as a lazy-parsed Zod schema (`parseEnvConfig`); `EVALS_REQUIRE_CONFIRMATION` uses `z.stringbool()`.

## Implementation Order

1. **Config and server setup** — `server-config.ts` (the four `EVALS_*` vars: `EVALS_DATA_DIR`, `EVALS_REQUIRE_CONFIRMATION`, `EVALS_DEFAULT_LICENSE`, `EVALS_CAPTURE_DIR`), `createApp()` identity (`name`/`title` = `evals-mcp-server`).
2. **Services** — `record-store` (filesystem CRUD, the submit move/freeze, `content_hash`, discard, exports dir), `grader` (DSL execution + committability check, math.js for `numeric`), `exporter`.
3. **Schema + read tools** — the `EvalRecord` discriminated union, `Grader` union, and sub-types; `evals_describe_schema`, `evals_get_record`, `evals_list_records`, `evals_run_check`.
4. **Authoring tools** — `evals_create_draft` (with the parrot-back / review-protocol / subagent-prompt response), `evals_revise_draft` (surgical patch + re-check), `evals_discard_draft` (draft delete).
5. **Gate** — `evals_submit_draft` (committability invariant + `llm_rubric`-degradation + typed error contract + freeze).
6. **Compile** — `evals_export_records` (the four formats, written under `exports/`).
7. **Resource** — `eval://record/{id}` (optional convenience mirror).

Each step is independently testable.

## Workflow Analysis

Two tools are multi-step. Both run entirely server-side (no upstream calls) — the "calls" below are internal grader/store operations.

`evals_create_draft` — persist + reflect:

| # | Step | Purpose | Always / conditional |
|:--|:-----|:--------|:---------------------|
| 1 | Validate against the `task_type` discriminated union | Reject malformed records before persisting | always |
| 2 | Compute `content_hash`, assign `id`, write `drafts/<id>.json` (status `draft`) | Persist the draft | always |
| 3 | Run self-consistency: grader vs gold + each positive (must PASS), vs each negative (must REJECT) | Cheap discrimination check (not the gate) | always |
| 4 | Build parrot-back + review protocol + `suggested_subagent_prompt` + `required_before_submit` | The reflection forcing function | always |

`evals_submit_draft` — the gate:

| # | Step | Purpose | Mode gate |
|:--|:-----|:--------|:----------|
| 0 | `ctx.elicit` confirmation | Human approval before finalize | when `EVALS_REQUIRE_CONFIRMATION` (or `confirm`) and client supports elicit |
| 1 | Re-run grader vs gold → must PASS | Catches wrong gold / broken grader | always (skipped for `llm_rubric` without `ctx.sample` → `server_verified: false`) |
| 2 | Run grader vs each negative → must REJECT (≥1 required) | Catches a grader that accepts everything | always (skipped as above) |
| 3 | Assert a recorded independent verification exists and its computed value agrees with gold | Catches a wrong-but-self-consistent gold; enforces decorrelation | always |
| 4 | Check `content_hash` not already in `submitted/` | Dedup | always |
| 5 | Move `drafts/<id>.json → submitted/<id>.json`, stamp `submitted_at` + `checksum`, freeze | Finalize | on all checks passing |

Re-checking the final draft at submit (steps 1–4) means there is no stale-verification hazard — you can't verify one version and submit another.

## Design Decisions

1. **Server runs the grader; a fresh subagent provides decorrelated correctness review.** Deterministic kinds are graded server-side as a hard gate so the agent can't merely assert correctness; `llm_rubric` uses `ctx.sample` when available, else is agent-attested and flagged. The decorrelated check (subagent, or the author's own independent derivation) is required and recorded — it's what catches a wrong gold that self-consistency alone passes.
2. **Fleet grounding is authoritative framework capture, not agent-carried.** Every framework server with `EVALS_CAPTURE_DIR` set writes its full tool output to a shared capture dir keyed by an EvalsID; the eval server reads that dir and embeds the dump. The agent supplies only the linking id(s) plus its own authored data — it is never the source of truth for provenance. The eval server still has **no outbound MCP client** (it reads files; stdio servers can't be dialed anyway). Depends on cyanheads/mcp-ts-core#247.
3. **No per-submit human elicit by default.** The draft → review → submit loop *is* the confirmation, and it's the agent's. A per-record human gate would kill batch authoring. `EVALS_REQUIRE_CONFIRMATION` (or a per-call `confirm`) opts in; the natural human checkpoint is export, not per-record submit.
4. **Plain JSON files under `EVALS_DATA_DIR`, not a database or `ctx.state`.** Inspectable, diffable, version-controllable on-disk records beat opaque KV for an artifact whose whole value is auditability. In-memory filter for `evals_list_records`/`evals_export_records` is fine at authoring-workflow corpus sizes; a corpus index is deferred until the tree grows large.
5. **No prompts primitive.** The instructional content (parrot-back, review protocol, subagent prompt) must be tailored to the just-drafted record's live state, which a static client-invokable prompt template can't do — so it lives in the `evals_create_draft` tool response instead.
6. **Stable id across the lifecycle; rubric folded into the grader.** The id is assigned once at draft and never changes (a draft→submit id swap would break `evals_get_record`, references, and the resource URI). `free_response`'s rubric lives in its `llm_rubric` grader rather than a parallel `record.rubric`, so there's a single source for criteria/threshold.

## Known Limitations

| Limit | Reality |
|:------|:--------|
| Self-consistency ≠ correctness | The gate proves gold passes its grader, not that gold is *right*. Subagent review + decorrelated check + live-source grounding address correctness — they reduce, not eliminate, the gap. |
| Reviewer/author correlation | A fresh subagent decorrelates by context, but a same-model-family reviewer can share a blind spot. Live-source grounding and deterministic checks are the harder backstops. |
| `llm_rubric` without sampling | When the client doesn't support `ctx.sample`, `free_response` records rest on recorded independent verification alone (`server_verified: false`) — weaker than a deterministic gate. |
| Contamination | A model can author trivia it memorized. Dedup (`content_hash`) + perturbation + optional baseline-difficulty capture help; not solved. |
| Code grading needs a sandbox | `code_tests` is the one genuinely hard piece — deferred to v2 or delegated to an external execution server. |
| CSV is lossy | Nested grader/discrimination fields don't survive flattening; JSONL is the lossless format. |

## v1 Scope vs. Deferred

**v1:** the 7 task types (`numeric` / `exact_answer` / `set_answer` / `mcq` / `regex_answer` / `json_answer` / `free_response`); the 9-tool surface; the `draft → submitted` loop with subagent-orchestrated review; server-side deterministic grading (`llm_rubric` via `ctx.sample` when available); JSON-file backing; the `captures` EvalsID field + resolver / gold cross-check (consumes cyanheads/mcp-ts-core#247); JSONL + CSV + Inspect + lm-eval export.

**Deferred:** `code_tests` (sandboxed execution); `agentic_trajectory` task type; server-side re-fetch of `source_provenance`; automated baseline-difficulty capture; a corpus index for large datasets.
