---
name: evals-guide
description: Use evals_* to author and independently verify eval records, resolve submission blockers, or export submitted records for a benchmark harness.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this server to build and export eval datasets. Bring the problem and the sources or computation needed to verify its reference answer (the gold). Run the model under test and any rubric judge in your evaluation harness.

## Identifiers

- Keep the `draft_id` returned by `evals_create_draft`. The same record ID works in `evals_get_record` and `eval://record/{id}` before and after submission. To recover an ID, use the `id` from `evals_list_records`.
- An EvalsID identifies a captured source-tool response. Use one only if a capture producer supplied it. Automatic framework capture production is pending. When no EvalsID exists, record the source lookup or independent computation as verification evidence.

## Gates

- **Derive the answer before comparing it.** Give a fresh reviewer the problem, context, and any choices first. Have them solve it independently or look it up in an authoritative source before they inspect the gold or grader target. If a fresh reviewer is unavailable, use a different method yourself. A pass from `evals_run_check` against the saved reference establishes agreement with that reference. For example, independently enumerate the outcomes of a probability problem before comparing the result with the saved numeric target.
- **Record the method and what it found.** For a source lookup, record the query, retrieved value, and source citation where available. For a deterministic check, record the computed value and whether it agrees. Resolve any disagreement and refresh evidence affected by a change to the task or reference.
- **Read readiness as a draft-local result.** `ready_to_submit` covers the record's grading, evidence, and decorrelation checks. Submit still checks duplicates, resolves captures when configured, and can ask for confirmation. Treat the record as frozen once submit returns `submitted`. If it reports the record is already frozen, use `evals_get_record` to confirm its status.
- **Plan rubric scoring downstream.** An `llm_rubric` draft still needs a declared negative and independent verification. Submit skips grader verdicts and returns `grader_run.server_verified: false`. Apply the rubric in your harness before reporting candidate scores.

## Core chain

1. Use `evals_describe_schema` for the task type. Draft with `evals_create_draft` and inspect the normalized record. For deterministic graders, exercise near misses as well as the gold so a broad regex or loose tolerance does not reward an incorrect answer.
2. After the independent check, use `evals_revise_draft` to record the evidence and apply the fixes. Inspect the new readiness result.
3. Call `evals_submit_draft` for the reviewed ID. If it reports a duplicate, inspect the existing record identified in the error. Changing tags or discrimination examples leaves the duplicate key unchanged.

## Workflows

**Ground an answer in tool output.** Run the source lookup yourself and record what it returned. If you have a capture ID, submit resolves it afresh when capture resolution is configured. The server owns `captured_outputs`. A missing or failed capture blocks submission when resolution is enabled. With resolution disabled, an ID can remain a reference without an embedded capture.

**Check corpus coverage.** Follow `evals_list_records` continuation via `nextOffset` with the same filters until there is no next page. An out-of-range page can be empty even when records match. If list, export, or duplicate checking reports skipped invalid files, qualify any claims about absence, completeness, or uniqueness. List totals and export counts cover valid records only.

**Prepare the dataset for a harness.** `evals_export_records` selects submitted records and returns a server-side artifact path and a preview. Use the artifact for the full dataset. Choose JSONL for full records or CSV for a flat summary. The Inspect export is a sample array with context prepended to the prompt and MCQ targets encoded as Inspect choice labels (A–Z, then 1, 2, …). The lm-eval export is a data manifest with context, choices, and raw gold for a harness task adapter. Use `grader_spec` to implement the intended scoring in the downstream task. Built-in scorer or metric hints can omit behavior such as tolerances, normalization, or rubric criteria.
