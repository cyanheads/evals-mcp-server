/**
 * @fileoverview evals_run_check — a standalone deterministic grader. Runs a grader
 * spec against one or more candidate answers and returns PASS/REJECT per
 * candidate plus the resolved comparison value (e.g. the math.js-evaluated
 * target), so the caller sees why a candidate matched or missed. Used mid-loop by
 * the author or a verification subagent to re-derive or spot-check the gold,
 * decoupled from any persisted record.
 * @module mcp-server/tools/definitions/run-check.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { GraderSchema } from '@/services/eval-record/schema.js';
import { gradeCandidate } from '@/services/grader/grader-service.js';

export const runCheckTool = tool('evals_run_check', {
  title: 'evals-mcp-server: run check',
  description:
    'Run a grader spec against one or more candidate answers and get a PASS/REJECT verdict per candidate, plus the resolved comparison value (e.g. the math.js-evaluated numeric target). Use it mid-loop to re-derive or spot-check a gold independently of any saved record. For grader kinds that grade against a reference rather than embedding one (exact_match), supply gold; it is ignored for target-embedding kinds like numeric and mcq. llm_rubric cannot run here — it is graded at submit via sampling.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    grader: GraderSchema,
    candidates: z
      .array(z.unknown())
      .min(1)
      .describe(
        'Candidate answers to grade — strings, numbers, objects, or arrays, matching what the grader kind expects.',
      ),
    gold: z
      .unknown()
      .optional()
      .describe(
        'The reference for gold-relative kinds (exact_match). A no-op for target-embedding kinds.',
      ),
    choices: z
      .array(z.string())
      .optional()
      .describe('The mcq choice set, used to validate the grader.correct value.'),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            candidate: z.unknown().describe('The candidate that was graded.'),
            pass: z
              .boolean()
              .describe(
                'True when the candidate passed the grader (PASS), false when rejected (REJECT).',
              ),
            detail: z.string().describe('Why the candidate matched or missed.'),
            resolved: z
              .unknown()
              .optional()
              .describe('The resolved comparison reference, e.g. the evaluated numeric target.'),
          })
          .describe('One candidate verdict.'),
      )
      .describe('Per-candidate grading verdicts, in input order.'),
    pass_count: z.number().describe('Number of candidates that passed.'),
  }),
  errors: [
    {
      reason: 'grader_unexecutable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The grader spec cannot run (malformed math.js target, invalid regex, missing json_match reference, or llm_rubric).',
      recovery:
        'Fix the named grader field — correct the math.js expression, regex pattern, or supply expected/schema — then retry.',
    },
    {
      reason: 'mcq_choice_mismatch',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The mcq grader correct answer is not one of the supplied choices.',
      recovery:
        'Set grader.correct to one of the choices, or correct the choices array, then retry.',
    },
  ],

  handler(input, ctx) {
    const results = input.candidates.map((candidate) => {
      const r = gradeCandidate(input.grader, candidate, input.gold, input.choices);
      return {
        candidate,
        pass: r.pass,
        detail: r.detail,
        ...(r.resolved !== undefined ? { resolved: r.resolved } : {}),
      };
    });
    const passCount = results.filter((r) => r.pass).length;
    ctx.log.debug('Ran check', {
      kind: input.grader.kind,
      candidates: input.candidates.length,
      passCount,
    });
    return { results, pass_count: passCount };
  },

  format: (result) => {
    const lines = result.results.map((r) => {
      const cand = JSON.stringify(r.candidate);
      const resolved =
        r.resolved === undefined ? '' : ` (resolved reference ${JSON.stringify(r.resolved)})`;
      return `- ${r.pass ? 'PASS' : 'REJECT'} candidate \`${cand}\`${resolved} — ${r.detail}`;
    });
    lines.push(`**${result.pass_count}/${result.results.length} passed.**`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
