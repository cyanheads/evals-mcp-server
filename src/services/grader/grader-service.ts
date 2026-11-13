/**
 * @fileoverview The grader service — deterministic, server-side execution of the
 * grader DSL kinds (numeric via math.js, exact/set/regex/mcq/json) returning
 * PASS/REJECT per candidate with the resolved comparison value, plus the
 * committability self-consistency aggregate (gold + positives pass, negatives
 * rejected). `llm_rubric` is not graded here; the record rests on recorded
 * independent verification. Throws `validationError` with `reason: 'grader_unexecutable'`
 * (or `reason: 'mcq_choice_mismatch'`) when a spec cannot run.
 * @module services/grader/grader-service
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { all, create, type MathJsInstance } from 'mathjs';
import type { Grader } from '@/services/eval-record/schema.js';
import { compileJsonSchema } from '@/services/grader/json-schema-validator.js';
import { stripLatex } from '@/services/grader/strip-latex.js';

/** Per-candidate grading verdict. */
export interface GradeResult {
  /** Human-readable reason the candidate matched or missed. */
  detail: string;
  /** True when the candidate passes the grader. */
  pass: boolean;
  /** The resolved comparison reference (e.g. the math.js-evaluated target), when the kind has one. */
  resolved?: unknown;
}

/** Aggregate self-consistency result over gold + positives + negatives. */
export interface SelfConsistency {
  gold_passes_grader: boolean;
  grader_ok: boolean;
  negatives_rejected: boolean[];
  positives_pass: boolean[];
  ready_to_submit: boolean;
  verification_present: boolean;
}

/**
 * A restricted math.js instance for numeric grading — the same dependency
 * `calculator-mcp-server` uses. `import` and `createUnit` are stripped so a
 * `target` expression can't redefine symbols or register units that reach Node
 * internals. The instance's own `evaluate` is used to resolve targets, so it is
 * not overridden (the narrow threat model here is an author resolving a numeric
 * reference, not an arbitrary public calculator surface).
 */
const math: MathJsInstance = create(all ?? {}, {});
math.import(
  {
    import: function disabled() {
      throw new Error('Function import is disabled');
    },
    createUnit: function disabled() {
      throw new Error('Function createUnit is disabled');
    },
  },
  { override: true },
);

/** Convert only finite real math.js scalars; units and collections have no numeric comparison. */
function realScalar(value: unknown): number | undefined {
  let number: number;
  if (typeof value === 'number') number = value;
  else if (math.isBigNumber(value) || math.isFraction(value)) number = math.number(value);
  else if (math.isComplex(value) && value.im === 0) number = value.re;
  else return;
  return Number.isFinite(number) ? number : undefined;
}

/**
 * Resolve a numeric target (number or math.js expression string) to a finite number.
 * Throws `grader_unexecutable` when the expression is malformed or non-numeric.
 */
function resolveNumber(value: number | string, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw validationError(`Numeric grader ${field} is not a finite number: ${value}.`, {
        reason: 'grader_unexecutable',
        field,
      });
    }
    return value;
  }
  let result: unknown;
  try {
    result = math.evaluate(value);
  } catch (err) {
    throw validationError(
      `Numeric grader ${field} could not be evaluated as a math.js expression: "${value}" (${(err as Error).message}).`,
      {
        reason: 'grader_unexecutable',
        field,
      },
    );
  }
  const n = realScalar(result);
  if (n === undefined) {
    throw validationError(
      `Numeric grader ${field} "${value}" did not resolve to a finite real scalar number.`,
      {
        reason: 'grader_unexecutable',
        field,
      },
    );
  }
  return n;
}

/** Parse a candidate to a number for numeric grading; non-numeric candidates simply fail (not an error). */
function candidateToNumber(candidate: unknown): number | undefined {
  if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : undefined;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return;
    try {
      return realScalar(math.evaluate(trimmed));
    } catch {
      return;
    }
  }
  return;
}

const STRIP_PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

/** Apply the `exact_match` normalization pipeline. */
function normalizeString(
  input: string,
  ops: Extract<Grader, { kind: 'exact_match' }>['normalize'],
): string {
  const opList = ops ?? [];
  let s = input;
  for (const op of opList) {
    switch (op) {
      case 'strip_latex':
        s = stripLatex(s);
        break;
      case 'strip_punct':
        s = s.replace(STRIP_PUNCT, ' ');
        break;
      case 'remove_punct':
        s = s.replace(STRIP_PUNCT, '');
        break;
      case 'lowercase':
        s = s.toLowerCase();
        break;
      case 'trim':
        s = s.trim().replace(/\s+/g, ' ');
        break;
    }
  }
  // strip_punct and strip_latex can leave dangling/collapsible whitespace after a
  // prior trim ran; re-collapse so normalization is order-insensitive when trim is requested.
  if (opList.includes('trim')) s = s.trim().replace(/\s+/g, ' ');
  return s;
}

/** Coerce a candidate to an array of trimmed string elements (accepts an array or a comma/newline-delimited string). */
function toElementSet(
  candidate: unknown,
  delimiter: Extract<Grader, { kind: 'set_match' }>['delimiter'],
): string[] | undefined {
  if (typeof candidate === 'string') {
    candidate = candidate.split(
      delimiter === 'comma' ? ',' : delimiter === 'newline' ? '\n' : /[,\n]/,
    );
  }
  if (!Array.isArray(candidate)) return;
  return candidate.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

/** Stable, key-sorted JSON for deep-equality comparison. */
function canonicalJson(value: unknown): string {
  const seen = new WeakSet();
  const sortKeys = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object))
      throw validationError('Cannot grade a json_match value containing a cycle.', {
        reason: 'grader_unexecutable',
        field: 'expected',
      });
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(sortKeys);
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * Grade a single candidate against a deterministic grader spec. `gold` supplies
 * the reference for gold-relative kinds (`exact_match`); it is ignored by
 * target-embedding kinds. `choices` validates the `mcq` correct answer.
 *
 * Throws for `llm_rubric` (not deterministic). Throws `grader_unexecutable`
 * when a spec is malformed.
 */
export function gradeCandidate(
  grader: Grader,
  candidate: unknown,
  gold?: unknown,
  choices?: string[],
): GradeResult {
  switch (grader.kind) {
    case 'numeric': {
      const target = resolveNumber(grader.target, 'target');
      const got = candidateToNumber(candidate);
      if (got === undefined) {
        return {
          pass: false,
          detail: `Candidate is not numeric; expected ${target}.`,
          resolved: target,
        };
      }
      const relTol = grader.rel_tol;
      const absTol = grader.abs_tol;
      const diff = Math.abs(got - target);
      let pass: boolean;
      if (relTol === undefined && absTol === undefined) {
        pass = diff <= 1e-9 * Math.max(1, Math.abs(target));
      } else {
        const relOk = relTol !== undefined && diff <= relTol * Math.abs(target);
        const absOk = absTol !== undefined && diff <= absTol;
        pass = relOk || absOk;
      }
      return {
        pass,
        detail: pass
          ? `${got} matches ${target} within tolerance.`
          : `${got} differs from ${target} by ${diff.toPrecision(4)} (outside tolerance).`,
        resolved: target,
      };
    }

    case 'exact_match': {
      if (gold === undefined) {
        throw validationError(
          'exact_match grading requires a gold reference; pass gold to evals_run_check or grade against a record.',
          {
            reason: 'grader_unexecutable',
            field: 'gold',
          },
        );
      }
      const normGold = normalizeString(String(gold), grader.normalize);
      const normCand = normalizeString(String(candidate), grader.normalize);
      const pass = normGold === normCand;
      return {
        pass,
        detail: pass
          ? `Candidate equals gold after normalization ("${normGold}").`
          : `Candidate "${normCand}" != gold "${normGold}" after normalization.`,
        resolved: normGold,
      };
    }

    case 'set_match': {
      const { normalize } = grader;
      const expected = normalize?.length
        ? grader.expected.map((value) => normalizeString(value, normalize))
        : grader.expected;
      const elements = toElementSet(candidate, grader.delimiter);
      const got = normalize?.length
        ? elements?.map((value) => normalizeString(value, normalize))
        : elements;
      if (got === undefined)
        return {
          pass: false,
          detail: 'Candidate is not a set (array or delimited string).',
          resolved: expected,
        };
      let pass: boolean;
      if (grader.order_sensitive) {
        pass = got.length === expected.length && got.every((v, i) => v === expected[i]);
      } else {
        const a = new Set(got);
        const b = new Set(expected);
        pass = a.size === b.size && b.isSubsetOf(a);
      }
      return {
        pass,
        detail: pass
          ? `Candidate set matches expected (${expected.length} elements).`
          : `Candidate set {${got.join(', ')}} != expected {${expected.join(', ')}}.`,
        resolved: expected,
      };
    }

    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(grader.pattern, grader.flags);
      } catch (err) {
        throw validationError(
          `regex grader pattern is invalid: /${grader.pattern}/${grader.flags ?? ''} (${(err as Error).message}).`,
          {
            reason: 'grader_unexecutable',
            field: 'pattern',
          },
        );
      }
      const pass = re.test(String(candidate));
      return {
        pass,
        detail: pass
          ? `Candidate matches /${grader.pattern}/${grader.flags ?? ''}.`
          : `Candidate does not match /${grader.pattern}/${grader.flags ?? ''}.`,
        resolved: grader.pattern,
      };
    }

    case 'mcq': {
      if (choices && choices.length > 0 && !choices.includes(grader.correct)) {
        throw validationError(
          `mcq grader correct answer "${grader.correct}" is not one of the choices: ${choices.join(', ')}.`,
          {
            reason: 'mcq_choice_mismatch',
            field: 'grader.correct',
          },
        );
      }
      const pass = String(candidate).trim() === grader.correct.trim();
      return {
        pass,
        detail: pass
          ? `Candidate equals the correct choice "${grader.correct}".`
          : `Candidate "${candidate}" != correct "${grader.correct}".`,
        resolved: grader.correct,
      };
    }

    case 'json_match': {
      if (grader.expected === undefined && grader.schema === undefined) {
        throw validationError('json_match grader requires at least one of expected or schema.', {
          reason: 'grader_unexecutable',
          field: 'expected',
        });
      }
      let expectedOk = true;
      let schemaOk = true;
      let diagnostic = '';
      const details: string[] = [];
      if (grader.expected !== undefined) {
        expectedOk = canonicalJson(grader.expected) === canonicalJson(candidate);
        details.push(expectedOk ? 'deep-equals expected' : 'differs from expected');
      }
      if (grader.schema !== undefined) {
        const {
          validate,
          errorsText,
          diagnostic: schemaDiagnostic,
        } = compileJsonSchema(grader.schema);
        diagnostic = schemaDiagnostic;
        schemaOk = validate(candidate) === true;
        details.push(
          schemaOk ? 'satisfies schema' : `schema violation: ${errorsText(validate.errors)}`,
        );
      }
      const pass = expectedOk && schemaOk;
      return {
        pass,
        detail: `Candidate ${details.join('; ')}.${diagnostic}`,
        resolved: grader.expected,
      };
    }

    case 'llm_rubric':
      throw validationError(
        'llm_rubric is not a deterministic grader and cannot run on this server; record an independent verification before submitting.',
        {
          reason: 'grader_unexecutable',
          field: 'kind',
        },
      );
  }
}

/**
 * Grade gold and every discrimination case. Rubrics leave deterministic
 * verdicts unset semantically, represented by the existing false placeholders.
 */
export function gradeDiscrimination(
  grader: Grader,
  gold: unknown,
  positives: unknown[],
  negatives: unknown[],
  choices: string[] | undefined,
): Omit<SelfConsistency, 'verification_present' | 'ready_to_submit'> & { goldDetail?: string } {
  if (grader.kind === 'llm_rubric') {
    return {
      gold_passes_grader: false,
      positives_pass: positives.map(() => false),
      negatives_rejected: negatives.map(() => false),
      grader_ok: false,
    };
  }

  const goldResult = gradeCandidate(grader, gold, gold, choices);
  const positivesPass = positives.map((p) => gradeCandidate(grader, p, gold, choices).pass);
  const negativesRejected = negatives.map((n) => !gradeCandidate(grader, n, gold, choices).pass);

  const graderOk =
    goldResult.pass &&
    positivesPass.every(Boolean) &&
    negatives.length > 0 &&
    negativesRejected.every(Boolean);

  return {
    gold_passes_grader: goldResult.pass,
    positives_pass: positivesPass,
    negatives_rejected: negativesRejected,
    grader_ok: graderOk,
    goldDetail: goldResult.detail,
  };
}
