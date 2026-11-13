/**
 * @fileoverview Unit tests for the grader service — each deterministic kind's
 * PASS/REJECT behavior, the resolved comparison value, and the self-consistency
 * aggregate (gold + positives pass, negatives rejected).
 * @module tests/services/grader.test
 */

import { describe, expect, it } from 'vitest';
import { type Grader, GraderSchema } from '@/services/eval-record/schema.js';
import { gradeCandidate } from '@/services/grader/grader-service.js';

describe('gradeCandidate — numeric', () => {
  const grader: Grader = { kind: 'numeric', target: '5/14', rel_tol: 1e-6 };

  it.each([
    ['5/14', 5 / 14],
    ['1e3', 1000],
    ['combinations(5,2)/combinations(8,2)', 5 / 14],
    ['bignumber("5")', 5],
    ['fraction(1,2)', 0.5],
    ['complex(5,0)', 5],
  ] as const)('preserves finite real scalar %s', (expression, expected) => {
    expect(gradeCandidate({ kind: 'numeric', target: expected }, expression).pass).toBe(true);
    expect(gradeCandidate({ kind: 'numeric', target: expression }, expected)).toMatchObject({
      pass: true,
      resolved: expected,
    });
  });

  it.each(['5 kg', '5 lbs', '5 meters', '2+3i', '[5]', 'true', 'Infinity', 'NaN'])(
    'rejects nonscalar or non-real candidate %s',
    (expression) => {
      expect(
        gradeCandidate({ kind: 'numeric', target: expression === '2+3i' ? 2 : 5 }, expression).pass,
      ).toBe(false);
    },
  );

  it.each(['5 kg', '2+3i', '[5]', 'true', 'Infinity', 'NaN'])(
    'fails invalid target %s with the declared reason',
    (target) => {
      expect(() => gradeCandidate({ kind: 'numeric', target }, 5)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'grader_unexecutable' }),
        }),
      );
    },
  );

  it('resolves a math.js expression target and passes an equal candidate', () => {
    const r = gradeCandidate(grader, '5/14');
    expect(r.pass).toBe(true);
    expect(r.resolved).toBeCloseTo(0.3571428, 6);
  });

  it('passes an equivalent fraction and a decimal within tolerance', () => {
    expect(gradeCandidate(grader, '10/28').pass).toBe(true);
    expect(gradeCandidate(grader, 0.357142857).pass).toBe(true);
  });

  it('rejects the with-replacement mistake (25/64)', () => {
    expect(gradeCandidate(grader, '25/64').pass).toBe(false);
  });

  it('rejects a 3-sig-fig answer under a tight rel_tol but accepts it when loosened', () => {
    expect(gradeCandidate({ kind: 'numeric', target: '5/14', rel_tol: 1e-6 }, '0.357').pass).toBe(
      false,
    );
    expect(gradeCandidate({ kind: 'numeric', target: '5/14', rel_tol: 1e-3 }, '0.357').pass).toBe(
      true,
    );
  });

  it('throws grader_unexecutable on a malformed target expression', () => {
    expect(() => gradeCandidate({ kind: 'numeric', target: '5/' }, '1')).toThrowError(
      /grader|evaluate/i,
    );
  });

  it('resolves combinations() expressions', () => {
    const r = gradeCandidate(
      { kind: 'numeric', target: 'combinations(5,2)/combinations(8,2)' },
      '5/14',
    );
    expect(r.pass).toBe(true);
  });

  it('passes within abs_tol when rel_tol is absent', () => {
    const g: Grader = { kind: 'numeric', target: 100, abs_tol: 0.5 };
    expect(gradeCandidate(g, 100.4).pass).toBe(true);
    expect(gradeCandidate(g, 101).pass).toBe(false);
  });

  it('uses a tight 1e-9 default when both tolerances are omitted', () => {
    const g: Grader = { kind: 'numeric', target: 1 };
    expect(gradeCandidate(g, 1).pass).toBe(true);
    expect(gradeCandidate(g, 1.0001).pass).toBe(false);
  });

  it('rejects a non-numeric candidate (not an error) and reports the resolved target', () => {
    const r = gradeCandidate({ kind: 'numeric', target: '5/14' }, 'not a number');
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/not numeric/i);
    expect(r.resolved).toBeCloseTo(0.3571428, 6);
  });

  it('rejects an empty-string candidate', () => {
    expect(gradeCandidate({ kind: 'numeric', target: '5/14' }, '   ').pass).toBe(false);
  });

  it('throws grader_unexecutable when the target resolves to a non-finite value', () => {
    expect(() =>
      gradeCandidate({ kind: 'numeric', target: Number.POSITIVE_INFINITY }, '1'),
    ).toThrowError(/finite/i);
  });
});

describe('gradeCandidate — exact_match (gold-relative)', () => {
  it('preserves token boundaries when stripping punctuation', () => {
    const grader: Grader = { kind: 'exact_match', normalize: ['strip_punct', 'trim'] };
    expect(gradeCandidate(grader, 'alpha beta', 'alpha-beta').pass).toBe(true);
    expect(gradeCandidate(grader, 'alphabeta', 'alpha-beta').pass).toBe(false);
  });
  it('passes after normalization and rejects a mismatch', () => {
    const grader: Grader = { kind: 'exact_match', normalize: ['trim', 'lowercase', 'strip_punct'] };
    expect(gradeCandidate(grader, '  Paris! ', 'paris').pass).toBe(true);
    expect(gradeCandidate(grader, 'London', 'paris').pass).toBe(false);
  });

  it('strips LaTeX wrappers', () => {
    const grader: Grader = { kind: 'exact_match', normalize: ['strip_latex', 'trim'] };
    expect(gradeCandidate(grader, '$x^2$', 'x^2').pass).toBe(true);
  });

  it('unwraps balanced nested groups and preserves escaped braces', () => {
    const grader: Grader = { kind: 'exact_match', normalize: ['strip_latex'] };
    expect(gradeCandidate(grader, '\\boxed{\\mathbf{\\frac{1}{2}}}', '\\frac{1}{2}').pass).toBe(
      true,
    );
    expect(gradeCandidate(grader, '\\boxed{a\\}b}', 'a\\}b').pass).toBe(true);
    expect(gradeCandidate(grader, '\\boxed{\\frac{1}{2}', '\\frac{1}{2}').pass).toBe(false);
  });

  it('deletes punctuation when explicitly requested', () => {
    const grader = GraderSchema.parse({
      kind: 'exact_match',
      normalize: ['remove_punct', 'lowercase'],
    });
    expect(gradeCandidate(grader, 'USA', 'U.S.A.').pass).toBe(true);
  });

  it('throws when no gold reference is supplied', () => {
    expect(() => gradeCandidate({ kind: 'exact_match' }, 'paris')).toThrowError(/gold/i);
  });
});

describe('gradeCandidate — set_match', () => {
  const grader: Grader = { kind: 'set_match', expected: ['a', 'b', 'c'] };

  it('accepts mixed delimiters and trailing newlines and preserves case by default', () => {
    expect(gradeCandidate(grader, 'a,b\nc').pass).toBe(true);
    expect(gradeCandidate(grader, 'a,b,c\n').pass).toBe(true);
    expect(gradeCandidate(grader, 'A,b,c').pass).toBe(false);
  });

  it('normalizes both sides after splitting and preserves commas inside newline elements', () => {
    const grader = GraderSchema.parse({
      kind: 'set_match',
      expected: ['Washington, D.C.', 'Ottawa'],
      delimiter: 'newline',
      normalize: ['lowercase'],
      order_sensitive: true,
    });
    expect(gradeCandidate(grader, 'WASHINGTON, D.C.\r\nOTTAWA').pass).toBe(true);
    expect(gradeCandidate(grader, ['WASHINGTON, D.C.', 'OTTAWA']).pass).toBe(true);
    expect(gradeCandidate(grader, 'OTTAWA\nWASHINGTON, D.C.').pass).toBe(false);
    expect(gradeCandidate(grader, '').pass).toBe(false);
  });

  it('passes an unordered match from an array or delimited string', () => {
    expect(gradeCandidate(grader, ['c', 'a', 'b']).pass).toBe(true);
    expect(gradeCandidate(grader, 'b, c, a').pass).toBe(true);
  });

  it('rejects a missing or extra element', () => {
    expect(gradeCandidate(grader, ['a', 'b']).pass).toBe(false);
    expect(gradeCandidate(grader, ['a', 'b', 'c', 'd']).pass).toBe(false);
  });

  it('enforces order when order_sensitive', () => {
    const ordered: Grader = { kind: 'set_match', expected: ['a', 'b', 'c'], order_sensitive: true };
    expect(gradeCandidate(ordered, ['a', 'b', 'c']).pass).toBe(true);
    expect(gradeCandidate(ordered, ['c', 'b', 'a']).pass).toBe(false);
  });

  it('rejects a non-set candidate (number) without throwing', () => {
    const r = gradeCandidate(grader, 42);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/not a set/i);
  });

  it('ignores whitespace and empty elements when splitting a delimited string', () => {
    expect(gradeCandidate(grader, ' a , b , , c ').pass).toBe(true);
  });
});

describe('gradeCandidate — regex', () => {
  it('passes a matching candidate and rejects a non-match', () => {
    const grader: Grader = { kind: 'regex', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
    expect(gradeCandidate(grader, '2026-06-23').pass).toBe(true);
    expect(gradeCandidate(grader, 'June 23').pass).toBe(false);
  });

  it('throws grader_unexecutable on an invalid pattern', () => {
    expect(() => gradeCandidate({ kind: 'regex', pattern: '(' }, 'x')).toThrowError(
      /regex|invalid/i,
    );
  });
});

describe('gradeCandidate — mcq', () => {
  it('passes the correct choice and validates correct ∈ choices', () => {
    const grader: Grader = { kind: 'mcq', correct: 'B' };
    expect(gradeCandidate(grader, 'B', undefined, ['A', 'B', 'C']).pass).toBe(true);
    expect(gradeCandidate(grader, 'A', undefined, ['A', 'B', 'C']).pass).toBe(false);
  });

  it('throws mcq_choice_mismatch when correct is not among choices', () => {
    expect(() =>
      gradeCandidate({ kind: 'mcq', correct: 'Z' }, 'Z', undefined, ['A', 'B']),
    ).toThrowError(/choice/i);
  });

  it('trims whitespace around the candidate before comparison', () => {
    expect(gradeCandidate({ kind: 'mcq', correct: 'B' }, '  B  ', undefined, ['A', 'B']).pass).toBe(
      true,
    );
  });

  it('grades without validating membership when choices are not supplied', () => {
    // No choices in scope (e.g. evals_run_check without choices) — correct ∈ choices is not enforced.
    expect(gradeCandidate({ kind: 'mcq', correct: 'B' }, 'B').pass).toBe(true);
  });
});

describe('gradeCandidate — json_match', () => {
  it.each([
    [true, 1],
    [true, 'invalid'],
    ['true', 1],
    [1, 1],
  ])('rejects async flag %j before executing a validator for %s', ($async, candidate) => {
    expect(() =>
      gradeCandidate({ kind: 'json_match', schema: { $async, type: 'number' } }, candidate),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'grader_unexecutable', field: 'schema' }),
      }),
    );
  });

  it('compares literal prototype-named keys inside arrays', () => {
    const grader: Grader = {
      kind: 'json_match',
      expected: JSON.parse('[{"__proto__":{"marker":1}}]'),
    };
    expect(gradeCandidate(grader, JSON.parse('[{"__proto__":{"marker":1}}]')).pass).toBe(true);
    expect(gradeCandidate(grader, JSON.parse('[{"__proto__":{"marker":2}}]')).pass).toBe(false);
  });

  it.each([
    {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      items: [{ type: 'string' }, { type: 'number' }],
      additionalItems: false,
    },
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      items: false,
    },
  ])('honors the declared tuple dialect $schema', (tuple) => {
    const grader: Grader = { kind: 'json_match', schema: { type: 'array', ...tuple } };
    expect(gradeCandidate(grader, ['a', 1]).pass).toBe(true);
    expect(gradeCandidate(grader, ['a', 1, 2]).pass).toBe(false);
  });

  it('names unknown keywords on PASS and REJECT without leaking diagnostics between schemas', () => {
    const grader: Grader = {
      kind: 'json_match',
      schema: { type: 'number', 'x-note': 'annotation' },
    };
    expect(gradeCandidate(grader, 1)).toMatchObject({
      pass: true,
      detail: expect.stringContaining('x-note'),
    });
    expect(gradeCandidate(grader, 'a')).toMatchObject({
      pass: false,
      detail: expect.stringContaining('x-note'),
    });
    expect(
      gradeCandidate({ kind: 'json_match', schema: { type: 'number' } }, 1).detail,
    ).not.toContain('x-note');
  });

  it('recompiles a changed schema object without sharing schema IDs across graders', () => {
    const schema = { $id: 'urn:example:grader', type: 'number' };
    const grader: Grader = { kind: 'json_match', schema };
    expect(gradeCandidate(grader, 1).pass).toBe(true);
    schema.type = 'string';
    expect(gradeCandidate(grader, 1).pass).toBe(false);
    expect(
      gradeCandidate({ kind: 'json_match', schema: { ...schema, type: 'number' } }, 1).pass,
    ).toBe(true);
  });
  it.each([
    undefined,
    'http://json-schema.org/draft-07/schema#',
    'http://json-schema.org/schema#',
    'http://json-schema.org/schema',
  ])('preserves draft-07 tuple validation for %s', (dialect) => {
    const schema = {
      ...(dialect === undefined ? {} : { $schema: dialect }),
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
      additionalItems: false,
    };
    const grader: Grader = { kind: 'json_match', schema };
    expect(gradeCandidate(grader, ['a', 1]).pass).toBe(true);
    expect(gradeCandidate(grader, ['a', 1, 2]).pass).toBe(false);
  });
  it('passes a deep-equal candidate regardless of key order', () => {
    const grader: Grader = { kind: 'json_match', expected: { a: 1, b: [2, 3] } };
    expect(gradeCandidate(grader, { b: [2, 3], a: 1 }).pass).toBe(true);
    expect(gradeCandidate(grader, { a: 1, b: [3, 2] }).pass).toBe(false);
  });

  it('validates against a JSON Schema', () => {
    const grader: Grader = {
      kind: 'json_match',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    };
    expect(gradeCandidate(grader, { id: 'x' }).pass).toBe(true);
    expect(gradeCandidate(grader, { id: 5 }).pass).toBe(false);
  });

  it('throws when neither expected nor schema is present', () => {
    expect(() => gradeCandidate({ kind: 'json_match' }, {})).toThrowError(/expected|schema/i);
  });

  it('requires the candidate to satisfy BOTH expected and schema when both are supplied', () => {
    const grader: Grader = {
      kind: 'json_match',
      expected: { id: 'x' },
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    };
    expect(gradeCandidate(grader, { id: 'x' }).pass).toBe(true);
    // Satisfies the schema but is not deep-equal to expected → fail.
    expect(gradeCandidate(grader, { id: 'y' }).pass).toBe(false);
  });

  it('throws grader_unexecutable on a candidate containing a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => gradeCandidate({ kind: 'json_match', expected: { a: 1 } }, cyclic)).toThrowError(
      /cycle/i,
    );
  });

  it('throws grader_unexecutable on a malformed JSON Schema', () => {
    expect(() =>
      gradeCandidate({ kind: 'json_match', schema: { type: 'not-a-real-type' } }, {}),
    ).toThrowError(/schema/i);
  });
});

describe('gradeCandidate — llm_rubric', () => {
  it('throws because it is not deterministic', () => {
    expect(() =>
      gradeCandidate(
        {
          kind: 'llm_rubric',
          criteria: [{ description: 'x' }],
          judge_prompt: 'j',
          pass_threshold: 0.5,
        },
        'answer',
      ),
    ).toThrowError(/llm_rubric|deterministic/i);
  });
});

describe('grader input bounds', () => {
  it.each(['rel_tol', 'abs_tol'])('requires nonnegative %s', (field) => {
    expect(GraderSchema.safeParse({ kind: 'numeric', target: 0, [field]: -0.1 }).success).toBe(
      false,
    );
    expect(GraderSchema.safeParse({ kind: 'numeric', target: 0, [field]: 0 }).success).toBe(true);
  });

  it.each([
    [-0.1, [1], false],
    [1.1, [1], false],
    [0.5, [-1, 1], false],
    [0.5, [0, 0], false],
    [0, [0, 1], true],
    [1, [0, undefined], true],
  ] as const)('validates rubric threshold %s and weights %j', (pass_threshold, weights, valid) => {
    expect(
      GraderSchema.safeParse({
        kind: 'llm_rubric',
        criteria: weights.map((weight) => ({ description: 'Criterion', weight })),
        judge_prompt: 'Grade it.',
        pass_threshold,
      }).success,
    ).toBe(valid);
  });
});
