# evals-mcp-server — Idea & Design

> Status: **built** (v1). This is the originating concept + rationale; the as-built MCP surface (tool tables, schema, error contract, implementation order) lives in [`design.md`](./design.md), and the reusable pattern in [`authoring-loop-pattern.md`](./authoring-loop-pattern.md) — read that first for the generic shape. This doc is kept as the design record of *why* the server is shaped this way; where it sketches a shape the build refined, `design.md` is authoritative.

## What it is

An MCP server that turns an agent into an **eval author**. The agent builds eval records through a **draft → review → surgical-revise → submit** loop: it drafts a record; the server reflects the parsed record back with a per-line review protocol; a fresh verification **subagent** independently checks it against live sources; the author applies **surgical updates**; and a server-side grader gate admits it to the corpus. Submitted records compile to standard eval formats.

It is the first instance of the [authoring-loop archetype](./authoring-loop-pattern.md): the server is not a data source the agent queries — it is the surface through which the agent *produces a verified artifact*, acting as both **scribe** (normalize, persist, compile) and **adversarial checker** (run the record's own grader, reject what doesn't hold up).

**Operating assumption:** the environment can spawn subagents that are also connected to this server. Verification is delegated to a fresh, medium-tier (Sonnet-class) subagent — see [Verification model](#verification-model). The server is designed around this and degrades gracefully when subagents aren't available.

## Why it's worth building

- **Evals are the bottleneck, not compute.** The scarce asset in frontier model work is high-quality, verifiable eval data and reliable graders (RLVR, process supervision, contamination-resistant benchmarks). A harness that produces *verified* records — each carrying its own executable grader — is worth far more than one that produces raw Q&A.
- **The loop forces reflection the protocol guarantees.** Draft-mirror-review-revise-submit makes the model see its own record laid out, get it independently reviewed by a fresh context, patch it, and clear a server-side gate. The structure does the work, not a prompt asking nicely.
- **It composes with the rest of the fleet.** The 80+ data servers become a live ground-truth layer (see [Fleet as ground-truth](#fleet-as-a-ground-truth-layer)).

## The authoring loop

| # | Step | Actor | Tool | Server does |
|---|---|---|---|---|
| 1 | **Draft** | author (top-tier) | `evals_create_draft` | Persist a `draft` JSON; parrot the parsed record back + review protocol + ready subagent prompt; run cheap self-consistency |
| 2 | **Review** | verification subagent (Sonnet-class, fresh context) | `evals_get_record` (+ `evals_run_check`) | Serve the draft read-only; expose deterministic checks |
| 3 | **Report** | subagent → author | *(agent-framework return)* | — |
| 4 | **Revise** | author | `evals_revise_draft` | Apply a **surgical** patch; re-run cheap checks |
| 5 | **Submit** | author | `evals_submit_draft` | Run the grader gate on the *final* draft; on pass, flip to `submitted` + freeze |
| 6 | **Compile** | author | `evals_export_records` | Compile submitted records to JSONL / CSV / harness formats |

Two persisted states only: **`draft`** and **`submitted`**. Steps 2–4 loop until the author is satisfied. Because `evals_submit_draft` re-checks the final draft, there's no stale-verification hazard.

## Core mechanism: the committability invariant

The rule the `evals_submit_draft` gate enforces:

> A verifiable eval record is **submittable only if** its declared grader, executed server-side against its declared gold answer, returns **PASS** — *and* at least one declared **negative** case (a known-wrong answer) is correctly **REJECTED** by that grader.

Enforced mechanically at submit. It kills the three most common eval defects:

| Defect | Caught by |
|---|---|
| Wrong gold answer | Grader run against gold fails → not submittable |
| Broken / unexecutable grader | Grader fails to run → not submittable |
| Grader that accepts everything | Negative case passes when it should fail → not submittable |

The invariant proves **self-consistency** (gold passes its own grader; the grader discriminates). It does **not** prove **correctness** (that gold is the *right* answer) — that's the job of the [subagent review + decorrelated check](#verification-model). See the [worked example](#appendix-worked-round-trip) for why both are needed.

## The eval record

A discriminated union keyed on `task_type` — each type enforces its own required fields (Zod `discriminatedUnion`).

```ts
type EvalRecord = {
  id: string;                       // server-assigned
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
  choices?: string[];              // required for mcq (free_response carries its rubric in its llm_rubric grader)
  metadata: {
    domain: string;                 // e.g. "math.probability", "finance.filings"
    tags: string[];
    license?: string;
    source_provenance?: Source[];   // citations; live-source verification lands here
    contamination_notes?: string;
  };
  verification: {
    method: string;                 // how gold was checked (e.g. "independent_derivation", "external_source")
    generation_method?: string;     // how the answer was produced (for decorrelation)
    evidence: Evidence[];           // subagent report, tool traces, computed values, source lookups
    attestation?: string;
  };
  captures?: string[];              // EvalsIDs linking the fleet tool calls behind the answer (resolved from EVALS_CAPTURE_DIR)
  provenance: { author_model: string; created_at: string };
  submitted_at?: string;
  checksum?: string;                // set at submit; immutability anchor
};
```

`task_type` (v1): `numeric` · `exact_answer` · `set_answer` · `mcq` · `regex_answer` · `json_answer` · `free_response` (rubric-graded). Deferred: `code` (sandbox), `agentic_trajectory`.

## Grader DSL

Each grader is a small typed variant, serialized with the record, executed by the server (deterministic kinds) or an LLM judge (`llm_rubric`).

```ts
type Grader =
  | { kind: "numeric"; target: number | string; rel_tol?: number; abs_tol?: number; units?: string } // target: math.js expr
  | { kind: "exact_match"; normalize?: ("trim" | "lowercase" | "strip_punct" | "strip_latex")[] }
  | { kind: "set_match"; expected: string[]; order_sensitive?: boolean }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "mcq"; correct: string }                       // key into choices[]
  | { kind: "json_match"; expected?: unknown; schema?: object }
  | { kind: "llm_rubric"; criteria: Criterion[]; judge_prompt: string; pass_threshold: number }
  // deferred — needs sandbox:
  | { kind: "code_tests"; language: "python" | "javascript"; tests: TestCase[]; entrypoint?: string };
```

`numeric` runs through math.js (same dependency as `calculator-mcp-server`), so `target` accepts an expression string (`"5/14"`, `"combinations(5,2)/combinations(8,2)"`) resolved to a number. The deterministic kinds are executed by the server itself — the agent can't merely *assert* the gold is correct.

## The draft response: parrot-back + review protocol + subagent prompt

`evals_create_draft` is the reflection forcing function. Its response carries the same payload on both client surfaces (`structuredContent` fields + the `format()` markdown twin):

**Structured fields:** `draft_id`, `status`, `normalized_record`, `server_checks`, `review_protocol`, `suggested_subagent_prompt`, `required_before_submit`.

**`format()` rendering** — parrots the record back behind a divider, then the protocol and a ready-to-paste subagent prompt:

```text
Draft saved: ev_7Qk2mNpX   (status: draft)

──────────────────────  REVIEW BEFORE SUBMIT  ──────────────────────
task_type:  numeric
prompt:     "A bag has 5 red and 3 blue marbles. Two are drawn without
             replacement. P(both red)?"
gold:       5/14  →  0.3571428571
grader:     numeric, target=0.3571428571 (from "5/14"), rel_tol=1e-6
positives:  10/28, 0.357142857
negative:   25/64    (rejected ✓)
domain:     math.probability
─────────────────────────────────────────────────────────────────────

Work through each line above. For every field ask: is it accurate,
unambiguous, and complete? Verify anything checkable against live /
authoritative sources — do not trust memory.

RECOMMENDED — independent verification via a subagent:
Spawn a subagent (Sonnet-tier is sufficient), connected to this server,
with the prompt below. It reviews the draft and reports back; then apply
surgical fixes with evals_revise_draft and finalize with evals_submit_draft.

  ┌─ subagent prompt ─────────────────────────────────────────────────┐
  │ Verify draft eval record ev_7Qk2mNpX. Call evals_get_record("ev_7Qk2mNpX").    │
  │ For each field check accuracy (verify claims against live sources), │
  │ ambiguity, and gaps. Independently re-derive or look up the gold.   │
  │ Report CONCISELY: one bullet per issue (field, problem, suggested   │
  │ fix), or "no issues". Do NOT modify the record — the authoring      │
  │ agent will apply surgical updates.                                  │
  └────────────────────────────────────────────────────────────────────┘

Still required before submit:
• An independent verification recorded on the record (the subagent's
  report, or your own decorrelated check).
```

## Surgical revision

`evals_revise_draft` applies a **surgical**, field-level patch to a `draft` — targeted fixes from the reviewer's findings, not a full rewrite. Explicit operations keep the change legible:

```jsonc
{
  "draft_id": "ev_7Qk2mNpX",
  "set":    { "grader.rel_tol": 1e-3 },
  "append": { "discrimination.positive": ["0.357"],
              "verification.evidence": [{ "type": "subagent_review", "model": "claude-sonnet-4-6", "findings": "…" }] },
  "unset":  []
}
```

The response returns the updated record, what changed, and a re-run of the cheap self-consistency check (the grader may have changed). Revise is `draft`-only; a `submitted` record is frozen.

## Verification model

Three layers, in order of strength:

1. **Server-side determinism (the gate).** For deterministic grader kinds, `evals_submit_draft` runs the verdict itself — gold must pass, negatives must be rejected. For `llm_rubric`, the server runs the judge via `ctx.sample` *when the client supports sampling*; otherwise the author runs it and the record is flagged `server_verified: false`.
2. **Subagent decorrelation (the correctness check).** A fresh Sonnet-class subagent, connected to the server, reviews the draft via `evals_get_record` and reports concisely. Fresh context = no shared reasoning state with the author = genuine independence, stronger than the author re-checking its own work. The subagent is **read-only**; the author records its findings onto the record (via `evals_revise_draft`) as evidence.
3. **Author's own decorrelated check (fallback / supplement).** When a subagent isn't available, or in addition to one, the author confirms the gold by a method *different from how it was generated* (`evals_run_check`, a fleet source, working backward). `submit` requires *some* recorded independent verification — the subagent's report or this.

The decorrelation rule: the verification path must differ from the generation path. Layer 2 satisfies it structurally; layer 3 satisfies it methodologically.

## Fleet as a ground-truth layer

The differentiator unique to this ecosystem. Gold answers can be grounded in **live, authoritative data** from sibling servers — contamination-resistant and traceable:

| Eval domain | Ground-truth source |
|---|---|
| Company financials | `secedgar` |
| Taxonomy / species facts | `gbif` / `wikidata` |
| Drug / chemical facts | `openfda` / `pubchem` |
| Biomedical literature | `pubmed` |
| Economic / statistical series | `worldbank` / `imf` / `bls` |

**Authoritative capture, not agent-carried (EvalsID).** Provenance comes from framework-level capture, not the agent's retelling (which is lossy and forgeable, and never holds the full untruncated output). Every framework server with `EVALS_CAPTURE_DIR` set writes its full tool output to a shared capture dir keyed by an **EvalsID** (`<server-prefix>_<shortid>`) and injects the id back into the response as a dedicated reserved field (`structuredContent._evals_id`, a `content[]` trailer, and `_meta`), not through `enrichment`. The agent adds the id(s) to the record's `captures: []` (on top of everything it authors today); the eval server reads the same dir, embeds the full dump into `captured_outputs[]`, lifts source URLs into `source_provenance`, and cross-checks the gold against the captured value. Still no outbound MCP client — the eval server reads files (and stdio servers can't be dialed anyway). Framework feature: cyanheads/mcp-ts-core#247.

## Tool surface

| Tool | Role |
|---|---|
| `evals_describe_schema` | Required/optional fields + grader options for a `task_type`, before drafting |
| `evals_create_draft` | Create a draft → parrot-back + review protocol + subagent prompt; persists `draft` JSON |
| `evals_get_record` | Read a draft/submitted record (the subagent's entry point) |
| `evals_revise_draft` | Surgical field-level patch of a `draft` (`set`/`append`/`unset`) |
| `evals_discard_draft` | Delete a `draft` by id (`draft`-only) — clean up abandoned drafts |
| `evals_run_check` | Standalone deterministic checker (`numeric`/`exact`/`set`/`regex`/`mcq`/`json`) — used mid-loop by author or subagent |
| `evals_submit_draft` | Gated finalize: server-side grader checks → flip to `submitted` + freeze |
| `evals_list_records` | Browse/filter records by status / domain / task_type / tag |
| `evals_export_records` | Compile submitted records to JSONL / CSV / Inspect AI / lm-eval-harness |

Naming follows the framework convention: `evals_` prefix + a uniform `verb_noun` shape. `_draft` for the mutable authoring ops (create/revise/discard/submit), `_record(s)` for read/emit (get/list/export).

### Typed error contract (`evals_submit_draft`)

`verification_incomplete` · `grader_failed_on_gold` · `verification_disagrees_with_gold` · `missing_negative_case` · `negative_case_passed` · `duplicate` · `decorrelation_violation` · `capture_unresolved`.

## Data backing & config

Records are **plain JSON files** under a configured data directory — no database. Drafts and submitted records are inspectable, diffable, and version-controllable on disk.

```
$EVALS_DATA_DIR/
  drafts/<id>.json        # status: draft — created by evals_create_draft, patched by evals_revise_draft
  submitted/<id>.json     # status: submitted — frozen at evals_submit_draft (+ checksum, submitted_at)
```

`evals_submit_draft` moves the file `drafts/ → submitted/`, stamps `submitted_at` + `checksum`, and freezes it (the `id` is stable — only `status` and location change). `evals_list_records`/`evals_export_records` read the tree directly (in-memory filter; fine for the corpus sizes an authoring workflow produces — add an index only if it grows large). For hosted multi-user use, namespace by a tenant subdir under the root.

| Env var | Required | Description |
|---|---|---|
| `EVALS_DATA_DIR` | yes | Root folder for record JSON (`drafts/`, `submitted/`) |
| `EVALS_REQUIRE_CONFIRMATION` | no (default `false`) | When `true`, `evals_submit_draft` fires `ctx.elicit` for human confirmation where the client supports it |
| `EVALS_DEFAULT_LICENSE` | no | Default `metadata.license` when a draft omits it |
| `EVALS_CAPTURE_DIR` | no | Dir of framework-written tool-call captures (same path the fleet servers write to); when set, `captures` EvalsIDs resolve to full dumps |

## Export / compile

`evals_export_records` compiles **submitted** records (all, or by filter):

| Format | Shape | Use |
|---|---|---|
| `jsonl` | one record per line, lossless | the lingua franca; re-import, archive |
| `csv` | flattened summary (`id, task_type, prompt, gold, grader.kind, domain, tags, status`) | quick tabular review in a spreadsheet — **lossy** (nested grader/discrimination dropped) |
| `inspect` | Inspect AI task/sample format | run in UK AISI Inspect |
| `lm-eval` | lm-evaluation-harness manifest | run in EleutherAI's harness |

The grader DSL maps to each harness's scoring primitive where one exists; unmapped kinds export with the grader spec inline.

## Honest limits

| Limit | Reality |
|---|---|
| Self-consistency ≠ correctness | The gate proves gold passes its grader, not that gold is *right*. The subagent review + decorrelated check + live-source grounding are what address correctness — they reduce, not eliminate, the gap. |
| Reviewer/author correlation | A fresh subagent decorrelates by context, but if it's the same model family a shared blind spot can survive. Live-source grounding and deterministic checks are the harder backstops. |
| Contamination | A model can author trivia it memorized. Dedup + perturbation + (optional) baseline-difficulty capture help; not solved. |
| Code grading needs a sandbox | `code_tests` is the one genuinely hard piece — deferred to v2 or delegated to an external execution server. |
| CSV is lossy | Nested fields don't survive flattening; JSONL is the lossless format. |

## v1 scope vs. deferred

**v1:** `numeric` / `exact_answer` / `set_answer` / `mcq` / `regex_answer` / `json_answer` / `free_response` (rubric); the 9-tool surface; the `draft → submitted` loop with subagent-orchestrated review; server-side deterministic grading; JSON-file backing; the `captures` EvalsID field + resolver / gold cross-check (consumes cyanheads/mcp-ts-core#247); JSONL + CSV + Inspect export.

**Deferred:** `code_tests` (sandboxed execution); `agentic_trajectory` task type; server-side re-fetch of `source_provenance`; automated baseline-difficulty capture; a corpus index for large datasets.

## Resolved design decisions (v1 direction)

1. **Verification — server runs the grader; a fresh subagent provides decorrelated correctness review.** Deterministic kinds graded server-side (hard gate); `llm_rubric` via `ctx.sample` when available, else agent-attested + flagged. The decorrelated check (subagent, or the author's own independent derivation) is required and recorded; it's what catches a wrong gold.
2. **Fleet grounding via authoritative framework capture (EvalsID), not agent-carried.** Framework servers write full tool outputs to a shared capture dir keyed by an EvalsID; the eval server reads it and embeds the dump; the agent supplies only the linking id + its own data — never the source of truth for provenance. No outbound MCP client (it reads files; stdio can't be dialed). Framework feature: cyanheads/mcp-ts-core#247.
3. **No per-submit human elicit by default.** The draft→review→submit loop is the confirmation, and it's the agent's; per-record human elicit would kill batch authoring. Optional `EVALS_REQUIRE_CONFIRMATION` / per-call flag fires `ctx.elicit` when supported. The natural human checkpoint is export, not per-record submit.
4. **Plain JSON files under `EVALS_DATA_DIR`** (drafts/ + submitted/), tenant-subdir when hosted. Drops the earlier DataCanvas/StorageService machinery in favor of inspectable on-disk records.

## Appendix: worked round-trip (`numeric`)

A full authoring loop for one probability item, including the subagent review and a surgical revision. The item: *"5 red + 3 blue marbles, draw 2 without replacement. P(both red)?"* Gold `5/14`; negative case `25/64` (the with-replacement mistake).

### 1 — `evals_create_draft` (request)

```json
{
  "task_type": "numeric",
  "prompt": "A bag contains 5 red and 3 blue marbles. Two marbles are drawn at random without replacement. What is the probability that both are red?",
  "gold": "5/14",
  "grader": { "kind": "numeric", "target": "5/14", "rel_tol": 1e-6 },
  "discrimination": { "positive": ["10/28", "0.357142857"], "negative": ["25/64"] },
  "metadata": { "domain": "math.probability", "tags": ["combinatorics", "without-replacement"], "license": "CC-BY-4.0" },
  "provenance": { "author_model": "claude-opus-4-8" }
}
```

### 1 — response

Returns `draft_id: "ev_7Qk2mNpX"`, `status: "draft"`, the normalized record, `server_checks.self_consistency` (gold + positives pass, negative rejected), `required_before_submit`, and the **parrot-back + review protocol + subagent prompt** shown in [The draft response](#the-draft-response-parrot-back--review-protocol--subagent-prompt). It stays `draft` — self-consistency passing only proves the grader discriminates, not that `5/14` is right.

### 2 — subagent review (spawned by the author)

The author spawns a Sonnet-class subagent with the supplied prompt. The subagent calls `evals_get_record("ev_7Qk2mNpX")`, independently re-derives the gold via `evals_run_check` (combinations: `combinations(5,2)/combinations(8,2)` → `5/14` ✓), and reports back **concisely**:

```text
- gold: confirmed 5/14 via combinations, independent of the sequential derivation. ✓
- grader.rel_tol: 1e-6 rejects 3-sig-fig answers like "0.357" (rel_diff 4e-4 > 1e-6).
  If those should count, loosen to ~1e-3.
- negative 25/64: the canonical with-replacement error — good discriminator. ✓
- prompt: unambiguous.
```

### 3 — `evals_revise_draft` (author applies the surgical fix)

```json
{
  "draft_id": "ev_7Qk2mNpX",
  "set":    { "grader.rel_tol": 1e-3 },
  "append": {
    "discrimination.positive": ["0.357"],
    "verification.evidence": [{ "type": "subagent_review", "model": "claude-sonnet-4-6",
      "findings": "Gold confirmed via combinations; loosened rel_tol to accept 3-sig-fig answers; negative is the canonical with-replacement error.", "method": "independent_derivation" }]
  }
}
```

Response confirms the patch and re-runs self-consistency: gold + all three positives (incl. `0.357`) pass, negative still rejected, `ready_to_submit: true`.

### 4 — `evals_submit_draft` (request → frozen)

```json
// request
{ "draft_id": "ev_7Qk2mNpX" }
// response
{
  "id": "ev_7Qk2mNpX",
  "status": "submitted",
  "path": "$EVALS_DATA_DIR/submitted/ev_7Qk2mNpX.json",
  "checksum": "sha256:9f2a…",
  "grader_run": { "gold": "PASS", "positives": "3/3 PASS", "negatives": "1/1 REJECTED" },
  "verification": { "decorrelated_by": "subagent (claude-sonnet-4-6)", "evidence_count": 1 },
  "frozen": true
}
```

### Why the decorrelated review matters — the wrong-gold path

Had the author set gold to `25/64`, the submit gate's self-consistency **still passes** (the grader matches its own wrong gold). What catches it is the independent re-derivation in step 2 (or the author's own check): it computes `5/14`, which disagrees with the gold, so `evals_submit_draft` refuses —

```json
{
  "status": "draft",
  "error": {
    "reason": "verification_disagrees_with_gold",
    "message": "Independent verification computed 0.3571 (5/14) but gold is 25/64 (0.3906). Fix the gold or the grader before submitting.",
    "computed": 0.3571428571, "gold": 0.390625
  }
}
```

Self-consistency alone is hollow; paired with a decorrelated review, a wrong gold can't reach `submitted`.
