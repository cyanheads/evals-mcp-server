# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-09-21 · ⚠️ Breaking

HTTP now requires a stateful session — evals_submit_draft's confirmation needs a live session with 2025-era clients, so the Docker image and .env.example default to MCP_SESSION_MODE=stateful, and a stateless HTTP start now fails at boot.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-08-22

Adopts the current MCP SDK and protocol surface, including strict tool inputs, multi-round submit confirmation, and client-valid ValidationError envelopes.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-27

EVALS_DATA_DIR now defaults to ./evals-data so bare npx/bunx invocations start with no env setup; mcq grader correct-not-in-choices reports mcq_choice_mismatch instead of task_type_constraint; trimmed meta-coaching from the evals_get_record description.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-27

First release: an authoring-loop MCP server that turns an agent into an eval author — a draft → review → revise → submit loop with server-enforced graders and a committability gate, compiling submitted records to JSONL, CSV, Inspect AI, and lm-evaluation-harness.
