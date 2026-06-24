# Server archetype: the authoring loop

> A reusable MCP server pattern. `evals-mcp-server` is its first instance, but the pattern generalizes to any server whose job is to help an agent *produce* a verified structured artifact. **Candidate for promotion** into the mcp-ts-core `design-mcp-server` skill's server-shape catalog (alongside the Workflow and Instruction tool shapes).

## What it is

Most MCP servers are **consumers** — the agent calls them to retrieve or compute something. An *authoring-loop* server is the inverse: the agent is an **author**, and the server is the surface through which it produces, verifies, and finalizes a structured artifact. The server owns the artifact's lifecycle (`draft → submitted`), coaches the agent through a verify-before-finalize loop *via its tool responses*, and is designed to be driven by a **multi-agent loop** in which the author spawns verification subagents connected to the same server.

The premise that makes it work: **the authoring loop is the quality mechanism.** A plain "save this artifact" tool relies on the model getting it right in one shot. An authoring loop makes the model see its own artifact reflected back, get it independently reviewed by a fresh context, patch it surgically, and clear a server-side gate before anything becomes final.

## Operating assumption

The environment (the agent loop) can **spawn subagents that are also connected to this server**. The author delegates verification to a fresh, medium-tier subagent that views the draft through the server's read tools and reports back. The pattern is *designed around* this but does not *require* it — see [Graceful degradation](#graceful-degradation).

## When to use it

Reach for this archetype when:

- The deliverable is a **high-stakes structured artifact** — an eval record, a labeled training example, a knowledge-base entry, a structured finding/report, a policy or config — where a wrong artifact is costly and "looks plausible" is not good enough.
- **Correctness matters more than throughput.** The loop deliberately trades speed for rigor.
- **Independent verification is feasible** — the artifact can be checked against live sources, recomputed deterministically, or reviewed against explicit criteria.

Don't use it for data retrieval, one-shot computation, or any artifact that's cheap to get wrong.

## The loop

| # | Step | Actor | Tool | Server's role |
|---|---|---|---|---|
| 1 | **Draft** | author (top-tier) | `draft` | Persist the draft; **parrot the parsed artifact back** with a per-line review protocol + a ready-to-use subagent prompt; run cheap self-consistency checks |
| 2 | **Review** | verification subagent (mid-tier, **fresh context**) | `get` (+ `check`) | Serve the draft read-only; expose deterministic checks |
| 3 | **Report** | subagent → author | *(agent-framework return)* | — (the server doesn't mediate the report) |
| 4 | **Revise** | author | `revise` | Apply a **surgical** field-level patch; re-run cheap checks |
| 5 | **Submit** | author | `submit` | Run the server-side gate on the *final* artifact; on pass, flip to `submitted` and freeze |
| 6 | **Compile** | author | `export` | Compile submitted artifacts to downstream formats |

Steps 2–4 loop until the author is satisfied. Because step 5 re-checks the final artifact, there is no "stale verification" hazard — you can't verify one version and submit another.

## Principles

1. **Instructional responses.** The `draft` response is not a bare acknowledgement. It reflects the parsed artifact back, field by field, behind a clear divider, followed by a review protocol: *work through each line; for every field ask whether it's accurate, unambiguous, and complete; verify anything checkable against live sources rather than memory.* The tool response becomes a checklist the agent must work, not a receipt.
2. **Subagent-orchestrated verification — decorrelation by fresh context.** The response recommends spawning a medium-tier subagent, connected to the same server, that reads the draft (via the `get` tool), checks it independently, and reports back **concisely** (one bullet per issue: field, problem, suggested fix). A fresh context with no shared reasoning state is a stronger independent check than the same agent re-reading its own work. The reviewer is **read-only** — it never mutates the artifact; the author applies fixes.
3. **Surgical revision.** The author patches a draft at the **field level** before finalizing — targeted fixes drawn from the reviewer's findings, not full-record rewrites. The patch surface is explicit (`set` / `append` / `unset` by path) so changes are legible.
4. **Finalize is a gate, not a save.** The `submit` transition runs server-side deterministic checks and **refuses** if they fail. Quality is enforced mechanically at the boundary, not left to discipline.
5. **Persisted, inspectable state.** Drafts and submitted artifacts are plain JSON files under an env-selected data directory — transparent, diffable, recoverable, and trivially version-controllable.
6. **Compile / export.** Submitted artifacts compile to the downstream formats their consumers actually use.

## Contrast with existing shapes

| Shape | Agent's relationship | Server holds | Response style |
|---|---|---|---|
| Data-retrieval (most servers) | consumer | nothing, or a read-only mirror | data |
| Workflow tool | consumer (orchestration in one call) | transient at most | data + post-state |
| Instruction tool | guided actor | nothing | guidance (read-only, no artifact) |
| **Authoring loop** | **author** | **the artifact's lifecycle (`draft → submitted`)** | **guidance + parrot-back + a persisted, gated artifact** |

The authoring loop *combines* the Instruction tool's coaching with a stateful authoring lifecycle and subagent orchestration. It's the first shape where the server's primary output is something the agent *made*, not something it *fetched*.

## Generic tool surface

| Tool | Role |
|---|---|
| `{s}_describe_schema` | Required/optional fields for an artifact type, before drafting |
| `{s}_draft` | Create a draft → parrot-back + review protocol + subagent prompt |
| `{s}_get` | Read a draft/submitted artifact (the subagent's entry point) |
| `{s}_revise` | Surgical field-level patch of a draft |
| `{s}_check` | Standalone deterministic verifier, usable mid-loop by author or subagent |
| `{s}_submit` | Gated finalize: server-side checks → flip to `submitted` + freeze |
| `{s}_list` | Browse/filter drafts + submitted artifacts |
| `{s}_export` | Compile submitted artifacts to downstream formats |

## Graceful degradation

The subagent is **recommended, not required** — the server can't detect or force one. When the environment can't spawn subagents, the author performs the decorrelated check itself (the `check` tool plus live-source lookups in its own context). The `submit` gate still requires *some* recorded independent verification, so the quality floor holds either way; only the strength of decorrelation varies.

## Promotion

This file is the seed for a server-shape entry in `mcp-ts-core/skills/design-mcp-server/SKILL.md`. Promoting it is a framework change (versioned skill) and is deferred to a deliberate, Casey-directed step.
