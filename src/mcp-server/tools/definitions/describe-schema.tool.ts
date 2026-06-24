/**
 * @fileoverview evals_describe_schema — returns the required and optional fields
 * plus the grader options for a given task_type, so an agent can learn what a
 * record of that type needs before drafting. Static: derived from the record and
 * grader schemas, with no disk or runtime state.
 * @module mcp-server/tools/definitions/describe-schema.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { TaskTypeSchema } from '@/services/eval-record/schema.js';

/** Per-task-type required-field and grader guidance, derived from the design. */
const TASK_TYPE_GUIDE: Record<
  z.infer<typeof TaskTypeSchema>,
  { summary: string; goldShape: string; graderKinds: string[]; extraRequired: string[] }
> = {
  numeric: {
    summary: 'A numeric answer, graded by tolerance against a math.js-resolved target.',
    goldShape: 'A number or a math.js expression string, e.g. "5/14".',
    graderKinds: ['numeric'],
    extraRequired: [],
  },
  exact_answer: {
    summary: 'A short string answer, graded by normalized exact match against the gold.',
    goldShape: 'A string; the grader compares a candidate to it after the declared normalization.',
    graderKinds: ['exact_match'],
    extraRequired: [],
  },
  set_answer: {
    summary: 'A set of elements, graded for set membership (ordered or unordered).',
    goldShape: 'An array of strings (or a comma/newline-delimited string).',
    graderKinds: ['set_match'],
    extraRequired: [],
  },
  mcq: {
    summary: 'A multiple-choice selection, graded against the correct choice.',
    goldShape: 'The correct choice string; must appear in choices[].',
    graderKinds: ['mcq'],
    extraRequired: ['choices (the grader.correct must equal one element of choices)'],
  },
  regex_answer: {
    summary: 'A free-text answer accepted when it matches a regular expression.',
    goldShape: 'A representative passing string; the grader carries the pattern.',
    graderKinds: ['regex'],
    extraRequired: [],
  },
  json_answer: {
    summary: 'A structured JSON answer, graded by deep-equality and/or JSON Schema.',
    goldShape: 'Any JSON-serializable value; the grader carries expected and/or schema.',
    graderKinds: ['json_match'],
    extraRequired: [],
  },
  free_response: {
    summary: 'Rubric-graded prose, scored by an LLM judge via ctx.sample when available.',
    goldShape: 'A reference answer or exemplar; the rubric lives in the llm_rubric grader.',
    graderKinds: ['llm_rubric'],
    extraRequired: ['grader of kind llm_rubric (criteria + judge_prompt + pass_threshold)'],
  },
};

const SHARED_REQUIRED = [
  'task_type',
  'prompt',
  'gold',
  'grader',
  'discrimination (positive[], negative[] with ≥1 negative)',
  'metadata (domain, tags)',
];
const SHARED_OPTIONAL = [
  'context',
  'choices',
  'metadata.license',
  'metadata.source_provenance',
  'metadata.contamination_notes',
  'verification',
  'captures (EvalsIDs)',
  'author_model',
];

export const describeSchemaTool = tool('evals_describe_schema', {
  title: 'evals-mcp-server: describe schema',
  description:
    'Return the required and optional fields plus the grader options for a given task_type. Call this before drafting to learn what a record of that type needs. Static — derived from the schemas, with no disk or runtime state.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    task_type: TaskTypeSchema,
  }),
  output: z.object({
    task_type: TaskTypeSchema,
    summary: z.string().describe('A one-line description of what this task type tests.'),
    gold_shape: z.string().describe('The expected shape of the gold answer for this task type.'),
    grader_kinds: z
      .array(z.string())
      .describe('The grader kind(s) appropriate for this task type.'),
    required_fields: z.array(z.string()).describe('Fields a record of this type must include.'),
    optional_fields: z.array(z.string()).describe('Fields a record of this type may include.'),
    notes: z
      .string()
      .describe('Authoring guidance specific to this task type (e.g. mcq choice constraints).'),
  }),

  handler(input, ctx) {
    const guide = TASK_TYPE_GUIDE[input.task_type];
    ctx.log.debug('Describing task type schema', { task_type: input.task_type });
    return {
      task_type: input.task_type,
      summary: guide.summary,
      gold_shape: guide.goldShape,
      grader_kinds: guide.graderKinds,
      required_fields: [...SHARED_REQUIRED, ...guide.extraRequired],
      optional_fields: SHARED_OPTIONAL,
      notes:
        input.task_type === 'mcq'
          ? 'mcq requires choices[] and the grader.correct must equal one element of choices[].'
          : input.task_type === 'free_response'
            ? 'free_response requires an llm_rubric grader; it is graded server-side only when the client supports ctx.sample, otherwise it rests on recorded independent verification.'
            : 'Provide at least one negative case so the submit gate can prove the grader rejects a wrong answer.',
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.task_type}`);
    lines.push(result.summary);
    lines.push(`**Gold shape:** ${result.gold_shape}`);
    lines.push(`**Grader kinds:** ${result.grader_kinds.join(', ')}`);
    lines.push('**Required fields:**');
    for (const f of result.required_fields) lines.push(`- ${f}`);
    lines.push('**Optional fields:**');
    for (const f of result.optional_fields) lines.push(`- ${f}`);
    lines.push(`**Notes:** ${result.notes}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
