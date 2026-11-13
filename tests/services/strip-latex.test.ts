/**
 * @fileoverview CPU growth regression coverage for string normalization.
 * @module tests/services/strip-latex.test
 */

import { describe, expect, it } from 'vitest';
import { gradeCandidate } from '@/services/grader/grader-service.js';
import { stripLatex } from '@/services/grader/strip-latex.js';

function cpuPerCall(fn: () => unknown, repetitions: number): number {
  const start = process.threadCpuUsage();
  for (let i = 0; i < repetitions; i++) fn();
  const delta = process.threadCpuUsage(start);
  return (delta.user + delta.system) / repetitions;
}

describe('string normalization CPU growth', () => {
  it.each([
    ['unclosed groups', (size: number) => '\\boxed{'.repeat(Math.floor(size / 7))],
    [
      'nested groups',
      (size: number) =>
        '\\boxed{'.repeat(Math.floor(size / 8)) + 'x' + '}'.repeat(Math.floor(size / 8)),
    ],
    ['overlapping prefixes', (size: number) => '\\boxe\\boxedx'.repeat(Math.floor(size / 12))],
    ['a trailing line break', (size: number) => '\\boxe x'.repeat(Math.floor(size / 8)) + '\ny'],
    ['line breaks throughout', (size: number) => '\\; \r\n'.repeat(Math.floor(size / 5))],
    ['a single digit run', (size: number) => '1'.repeat(size)],
  ])(
    'stays bounded for %s',
    (_name, inputAt) => {
      const normalize = (input: string) => {
        stripLatex(input);
        gradeCandidate(
          { kind: 'set_match', expected: ['x'], normalize: ['trim', 'remove_punct'] },
          input,
        );
      };
      const small = inputAt(5_000);
      for (let size = 10_000; size <= 320_000; size *= 2) {
        const large = inputAt(size);
        const pairs = Array.from({ length: 5 }, () => {
          const baseline = cpuPerCall(() => normalize(small), 64);
          const candidate = cpuPerCall(() => normalize(large), 8);
          return { baseline, candidate };
        });
        expect(Math.min(...pairs.map(({ candidate }) => candidate))).toBeLessThan(100_000);
        expect(
          Math.min(...pairs.map(({ baseline, candidate }) => candidate / baseline)),
        ).toBeLessThan(4 * (size / 5_000));
      }
    },
    0,
  );
});
