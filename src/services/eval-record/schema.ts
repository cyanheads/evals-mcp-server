/**
 * @fileoverview The eval-record domain schema — the load-bearing Zod definitions
 * that drive every tool's input and output shape: the `Grader` typed union, the
 * `EvalRecord` discriminated union keyed on `task_type`, and the supporting
 * sub-types (`Source`, `Evidence`, `Criterion`, `Capture`). All types are
 * JSON-Schema-serializable; `json_match`'s `expected`/`schema` carry `unknown`/
 * structural objects validated at runtime rather than via Zod field types.
 * @module services/eval-record/schema
 */

import { z } from '@cyanheads/mcp-ts-core';

/** v1 task types — the discriminant of the eval record union. */
export const TASK_TYPES = [
  'numeric',
  'exact_answer',
  'set_answer',
  'mcq',
  'regex_answer',
  'json_answer',
  'free_response',
] as const;

export const TaskTypeSchema = z
  .enum(TASK_TYPES)
  .describe(
    'The eval task type. numeric: a number/expression answer; exact_answer: a normalized string; set_answer: an unordered/ordered set; mcq: a multiple-choice selection (requires choices); regex_answer: a pattern match; json_answer: a structured value; free_response: rubric-graded prose (requires an llm_rubric grader).',
  );
export type TaskType = z.infer<typeof TaskTypeSchema>;

// ---------------------------------------------------------------------------
// Grader DSL (typed union)
// ---------------------------------------------------------------------------

/** A normalization op applied by the `exact_match` grader before comparison. */
export const NormalizeOpSchema = z
  .enum(['trim', 'lowercase', 'strip_punct', 'strip_latex'])
  .describe(
    'A normalization step applied before comparison: trim whitespace, lowercase, strip punctuation, or strip LaTeX wrappers ($, \\(, \\text{}).',
  );

export const NumericGraderSchema = z
  .object({
    kind: z
      .literal('numeric')
      .describe('Numeric grader — resolves target through math.js, then compares with tolerance.'),
    target: z
      .union([
        z.number().describe('A literal reference number, e.g. 0.3571428571.'),
        z
          .string()
          .describe(
            'A math.js expression string, e.g. "5/14" or "combinations(5,2)/combinations(8,2)".',
          ),
      ])
      .describe(
        'Reference value as a number or a math.js expression string, resolved to a number for comparison.',
      ),
    rel_tol: z
      .number()
      .optional()
      .describe(
        'Relative tolerance for the comparison (e.g. 1e-6). Defaults to 1e-9 when both tolerances are omitted.',
      ),
    abs_tol: z.number().optional().describe('Absolute tolerance for the comparison (e.g. 1e-3).'),
    units: z
      .string()
      .optional()
      .describe('Expected units for documentation, e.g. "kg" — not enforced numerically.'),
  })
  .describe('Numeric tolerance grader.');

export const ExactMatchGraderSchema = z
  .object({
    kind: z
      .literal('exact_match')
      .describe(
        'Gold-relative string match — grades a candidate against the record gold after normalization.',
      ),
    normalize: z
      .array(NormalizeOpSchema)
      .optional()
      .describe('Normalization steps applied to both gold and candidate before exact comparison.'),
  })
  .describe('Gold-relative normalized string-equality grader.');

export const SetMatchGraderSchema = z
  .object({
    kind: z
      .literal('set_match')
      .describe('Set match — grades a candidate list/CSV against an expected set.'),
    expected: z
      .array(z.string())
      .describe('The expected set of string elements the candidate must contain.'),
    order_sensitive: z
      .boolean()
      .optional()
      .describe('When true, element order must match exactly. Defaults to unordered.'),
  })
  .describe('Set-membership grader (ordered or unordered).');

export const RegexGraderSchema = z
  .object({
    kind: z
      .literal('regex')
      .describe('Regex grader — a candidate passes when the pattern matches it.'),
    pattern: z
      .string()
      .describe('The regular expression pattern (JavaScript flavor) tested against the candidate.'),
    flags: z
      .string()
      .optional()
      .describe('Regex flags, e.g. "i" for case-insensitive or "m" for multiline.'),
  })
  .describe('Regular-expression match grader.');

export const McqGraderSchema = z
  .object({
    kind: z
      .literal('mcq')
      .describe('Multiple-choice grader — a candidate passes when it equals the correct choice.'),
    correct: z
      .string()
      .describe('The correct answer; must equal one element of the record choices[].'),
  })
  .describe('Multiple-choice grader.');

export const JsonMatchGraderSchema = z
  .object({
    kind: z
      .literal('json_match')
      .describe(
        'JSON grader — a candidate must deep-equal expected and/or satisfy a JSON Schema. At least one of expected/schema is required.',
      ),
    expected: z
      .unknown()
      .optional()
      .describe('A value the candidate must deep-equal (any JSON-serializable shape).'),
    schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'A JSON Schema object the candidate must structurally satisfy (validated by ajv at runtime).',
      ),
  })
  .describe('JSON deep-equality and/or JSON-Schema grader.');

export const CriterionSchema = z
  .object({
    description: z.string().describe('What the judge checks for this criterion.'),
    weight: z
      .number()
      .optional()
      .describe('Relative weight in the weighted pass score (default 1).'),
  })
  .describe('A single weighted rubric criterion.');

export const LlmRubricGraderSchema = z
  .object({
    kind: z
      .literal('llm_rubric')
      .describe(
        'LLM-judge grader — scores a candidate against weighted criteria via ctx.sample when the client supports sampling.',
      ),
    criteria: z
      .array(CriterionSchema)
      .min(1)
      .describe('The weighted criteria the judge evaluates the candidate against.'),
    judge_prompt: z
      .string()
      .describe('Instructions for the judge model on how to apply the criteria.'),
    pass_threshold: z.number().describe('Minimum weighted score (0..1) for the candidate to PASS.'),
  })
  .describe('LLM-rubric grader for free_response.');

/** The grader DSL — a discriminated union on `kind`. */
export const GraderSchema = z
  .discriminatedUnion('kind', [
    NumericGraderSchema,
    ExactMatchGraderSchema,
    SetMatchGraderSchema,
    RegexGraderSchema,
    McqGraderSchema,
    JsonMatchGraderSchema,
    LlmRubricGraderSchema,
  ])
  .describe(
    'The executable grader serialized with the record. Deterministic kinds run server-side; llm_rubric routes to ctx.sample.',
  );
export type Grader = z.infer<typeof GraderSchema>;

// ---------------------------------------------------------------------------
// Sub-types referenced by the record
// ---------------------------------------------------------------------------

export const SourceSchema = z
  .object({
    server: z.string().describe('Fleet server that supplied the value, e.g. "secedgar".'),
    query: z.string().describe('The call or query made against that server.'),
    value: z.string().describe('The retrieved ground-truth value.'),
    uri: z.string().optional().describe('Citation or permalink for the value.'),
    retrieved_at: z.string().describe('ISO 8601 timestamp of when the value was retrieved.'),
  })
  .describe('A ground-truth source citation grounding the gold answer.');
export type Source = z.infer<typeof SourceSchema>;

export const EvidenceSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z
          .literal('deterministic_check')
          .describe('A deterministic re-computation or verifier run.'),
        tool: z
          .string()
          .describe('The tool or method used to compute the claim, e.g. "evals_run_check".'),
        claim: z.string().describe('The claim that was checked.'),
        computed: z.unknown().optional().describe('The value the check computed, when applicable.'),
        passed: z.boolean().describe('Whether the deterministic check passed.'),
      })
      .describe('Deterministic re-derivation evidence.'),
    z
      .object({
        type: z
          .literal('subagent_review')
          .describe('A fresh-context subagent review of the draft.'),
        model: z.string().describe('The reviewing model, e.g. "claude-sonnet-4-6".'),
        method: z
          .string()
          .optional()
          .describe(
            'How the subagent verified the gold (for decorrelation), e.g. "independent_derivation".',
          ),
        findings: z
          .string()
          .describe('The subagent report, one concise summary of issues or confirmation.'),
      })
      .describe('Fresh-context subagent review evidence.'),
    z
      .object({
        type: z
          .literal('source_lookup')
          .describe('A live lookup against an authoritative fleet source.'),
        source: SourceSchema.describe('The source entry that grounds the gold.'),
      })
      .describe('Live source-lookup evidence.'),
    z
      .object({
        type: z.literal('note').describe('A free-form verification note.'),
        text: z.string().describe('The note text.'),
      })
      .describe('Free-form verification note.'),
  ])
  .describe('A single verification evidence entry, discriminated by type.');
export type Evidence = z.infer<typeof EvidenceSchema>;

/** A content block carried in a captured fleet tool-call dump. */
export const CaptureContentBlockSchema = z
  .record(z.string(), z.unknown())
  .describe('A content[] block the agent saw (text/image/audio), stored verbatim.');

export const CaptureSchema = z
  .object({
    evals_id: z.string().describe('The EvalsID linking this capture, "<server-prefix>_<shortid>".'),
    ts: z.string().describe('ISO 8601 UTC timestamp the capture was written.'),
    server: z.string().describe('The fleet server that produced the output.'),
    serverVersion: z
      .string()
      .describe('The server version that produced the output (for reproduction).'),
    tool: z.string().describe('The tool that was called.'),
    args: z.unknown().describe('The validated (post-parse) tool input.'),
    rawArgs: z
      .unknown()
      .optional()
      .describe('The input as received, only when it differs from args.'),
    structuredContent: z
      .unknown()
      .describe('The full, untruncated tool output (or the { error } envelope on failure).'),
    content: z
      .array(CaptureContentBlockSchema)
      .optional()
      .describe('The content[] blocks the agent saw.'),
    isError: z.boolean().describe('Whether the captured tool call errored.'),
    durationMs: z.number().optional().describe('Tool-call duration in milliseconds.'),
    traceId: z.string().optional().describe('OTel span id, when emitted.'),
  })
  .describe('A verbatim fleet tool-call capture dump resolved from EVALS_CAPTURE_DIR.');
export type Capture = z.infer<typeof CaptureSchema>;

// ---------------------------------------------------------------------------
// Shared record sub-objects
// ---------------------------------------------------------------------------

export const DiscriminationSchema = z
  .object({
    positive: z
      .array(z.unknown())
      .describe('Answers that MUST pass the grader (gold is implicitly one).'),
    negative: z
      .array(z.unknown())
      .describe(
        'Known-wrong answers that MUST fail the grader; at least one is required to submit.',
      ),
  })
  .describe(
    'The positive and negative discrimination cases proving the grader accepts right answers and rejects wrong ones.',
  );

export const MetadataSchema = z
  .object({
    domain: z.string().describe('The eval domain, e.g. "math.probability" or "finance.filings".'),
    tags: z.array(z.string()).describe('Free-form tags for filtering and grouping.'),
    license: z
      .string()
      .optional()
      .describe('SPDX-style license; defaults to EVALS_DEFAULT_LICENSE when omitted.'),
    source_provenance: z
      .array(SourceSchema)
      .optional()
      .describe('Citations grounding the gold; live-source verification lands here.'),
    contamination_notes: z
      .string()
      .optional()
      .describe('Notes on memorization/contamination risk for this item.'),
  })
  .describe('Record metadata: domain, tags, license, source citations, and contamination notes.');

export const VerificationSchema = z
  .object({
    method: z
      .string()
      .describe('How the gold was checked, e.g. "independent_derivation" or "external_source".'),
    generation_method: z
      .string()
      .optional()
      .describe(
        'How the answer was originally produced — used to enforce decorrelation against the verification path.',
      ),
    evidence: z
      .array(EvidenceSchema)
      .describe(
        'Recorded verification evidence: subagent reports, deterministic checks, source lookups, notes.',
      ),
    attestation: z.string().optional().describe('A free-form attestation by the author.'),
  })
  .describe(
    'The independent-verification record: method, generation method (for decorrelation), and evidence entries.',
  );

export const ProvenanceSchema = z
  .object({
    author_model: z
      .string()
      .describe('The authoring model; falls back to "unknown" when the caller omits it.'),
    created_at: z.string().describe('Server-stamped ISO 8601 creation time.'),
  })
  .describe('Authoring provenance: the author model and the server-stamped creation time.');

export const StatusSchema = z
  .enum(['draft', 'submitted'])
  .describe('The record lifecycle state: draft (mutable) or submitted (frozen).');
export type RecordStatus = z.infer<typeof StatusSchema>;

// ---------------------------------------------------------------------------
// EvalRecord — discriminated union on task_type
// ---------------------------------------------------------------------------

/**
 * Fields shared by every task-type variant. The variants below add the
 * per-type constraints (`mcq` requires `choices`; `free_response` requires an
 * `llm_rubric` grader). Cross-field rules (mcq.correct ∈ choices, etc.) are
 * enforced in the service layer where the full record is in scope.
 */
const recordBase = {
  id: z
    .string()
    .describe('Server-assigned id, ev_<nanoid(10)>, stable across the draft→submitted lifecycle.'),
  status: StatusSchema,
  prompt: z.string().min(1).describe('The task shown to the model under test.'),
  context: z.string().optional().describe('An optional grounding passage for the task.'),
  gold: z.unknown().describe('The reference answer; its shape depends on task_type.'),
  grader: GraderSchema,
  discrimination: DiscriminationSchema,
  choices: z.array(z.string()).optional().describe('The answer choices; required for mcq.'),
  metadata: MetadataSchema,
  verification: VerificationSchema,
  captures: z
    .array(z.string())
    .optional()
    .describe('Agent-supplied EvalsIDs linking the fleet tool calls behind the answer.'),
  captured_outputs: z
    .array(CaptureSchema)
    .optional()
    .describe('Full capture dumps resolved from EVALS_CAPTURE_DIR, embedded and frozen at submit.'),
  provenance: ProvenanceSchema,
  content_hash: z
    .string()
    .describe('SHA-256 over the semantic fields (sorted keys); the dedup key.'),
  submitted_at: z
    .string()
    .optional()
    .describe('Server-stamped ISO 8601 submit time; absent while draft.'),
  checksum: z
    .string()
    .optional()
    .describe('SHA-256 immutability anchor; set at submit, absent while draft.'),
};

/** The persisted/normalized eval record — a discriminated union on `task_type`. */
export const EvalRecordSchema = z
  .discriminatedUnion('task_type', [
    z.object({ task_type: z.literal('numeric'), ...recordBase }),
    z.object({ task_type: z.literal('exact_answer'), ...recordBase }),
    z.object({ task_type: z.literal('set_answer'), ...recordBase }),
    z.object({ task_type: z.literal('mcq'), ...recordBase }),
    z.object({ task_type: z.literal('regex_answer'), ...recordBase }),
    z.object({ task_type: z.literal('json_answer'), ...recordBase }),
    z.object({ task_type: z.literal('free_response'), ...recordBase }),
  ])
  .describe(
    'A persisted eval record carrying its own executable grader, discrimination cases, and verification evidence.',
  );
export type EvalRecord = z.infer<typeof EvalRecordSchema>;

/**
 * A flat object mirror of `EvalRecord` for use as a typed nested field where the
 * full field documentation is wanted (e.g. a resource `output`). The framework
 * constrains `output` to a ZodObject, so the discriminated union can't be a root
 * or be returned bare; this carries `task_type` as the enum and the same fields
 * as the union variants and round-trips any `EvalRecord`.
 */
export const RecordObjectSchema = z
  .object({ task_type: TaskTypeSchema, ...recordBase })
  .describe(
    'A full eval record as a flat object (the wrapped twin of the EvalRecord discriminated union).',
  );

/**
 * The whole-record payload as a passthrough object, for tool `output` fields that
 * echo an entire record back (get/revise/create). The record is one cohesive
 * artifact rendered as a JSON block in `format()`, so its inner fields are not
 * re-declared field-by-field on every read tool — passthrough flows the full
 * record to `structuredContent` while keeping format-parity to the JSON block.
 */
export const RecordPayloadSchema = z
  .object({})
  .passthrough()
  .describe(
    'A full eval record (id, status, task_type, prompt, context, gold, grader, discrimination, choices, metadata, verification, captures/captured_outputs, provenance, content_hash, and on submit submitted_at + checksum).',
  );

/** The self-consistency check result shared by create + revise responses. */
export const SelfConsistencySchema = z.object({
  gold_passes_grader: z.boolean().describe('True when the gold passes its own grader.'),
  positives_pass: z.array(z.boolean()).describe('Per-positive pass verdict, in declaration order.'),
  negatives_rejected: z
    .array(z.boolean())
    .describe('Per-negative rejection verdict (true = correctly rejected), in declaration order.'),
  grader_ok: z
    .boolean()
    .describe('True when gold + all positives pass and all negatives (≥1) are rejected.'),
  verification_present: z
    .boolean()
    .describe('True when at least one verification.evidence entry exists.'),
  ready_to_submit: z
    .boolean()
    .describe('True only when both grader_ok and verification_present are true.'),
});

/** The reusable input shape for the optional draft-time verification block. */
export const VerificationInputSchema = z.object({
  method: z.string().describe('How the gold was checked, e.g. "independent_derivation".'),
  generation_method: z
    .string()
    .optional()
    .describe('How the answer was produced, for decorrelation against the verification path.'),
  evidence: z
    .array(EvidenceSchema)
    .optional()
    .describe('Pre-recorded verification evidence available at draft time.'),
});

/** The summary projection returned by `evals_list_records`. */
export const RecordSummarySchema = z
  .object({
    id: z.string().describe('The record id.'),
    status: StatusSchema,
    task_type: TaskTypeSchema,
    domain: z.string().describe('The record domain from metadata.domain.'),
    tags: z.array(z.string()).describe('The record tags from metadata.tags.'),
    created_at: z.string().describe('Server-stamped creation time.'),
    submitted_at: z
      .string()
      .optional()
      .describe('Submit time; present only for submitted records.'),
  })
  .describe('A compact record summary (id, status, task_type, domain, tags, timestamps).');
export type RecordSummary = z.infer<typeof RecordSummarySchema>;
