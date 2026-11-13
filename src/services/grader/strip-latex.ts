/**
 * @fileoverview Remove supported LaTeX wrappers while preserving balanced inner groups.
 * @module services/grader/strip-latex
 */

const WRAPPERS = ['\\text{', '\\mathrm{', '\\mathbf{', '\\boxed{'];

/** Remove presentation wrappers and delimiters, preserving unmatched groups and escaped braces. */
export function stripLatex(input: string): string {
  if (!input.includes('\\') && !input.includes('$')) return input;
  const groups: { start: number; width: number }[] = [];
  const removals = new Map<number, number>();
  for (let i = 0; i < input.length; i++) {
    switch (input[i]) {
      case '\\': {
        const wrapper = WRAPPERS.find((prefix) => input.startsWith(prefix, i));
        if (wrapper) {
          groups.push({ start: i, width: wrapper.length });
          i += wrapper.length - 1;
          break;
        }
        const next = input[i + 1];
        if (next !== undefined && '()[],;'.includes(next)) {
          removals.set(i, 2);
          i++;
        } else if (next === '{' || next === '}' || next === '\\') {
          i++;
        }
        break;
      }
      case '{':
        groups.push({ start: i, width: 0 });
        break;
      case '}': {
        const group = groups.pop();
        if (group?.width) {
          removals.set(group.start, group.width);
          removals.set(i, 1);
        }
        break;
      }
      case '$':
        removals.set(i, 1);
        break;
    }
  }

  if (removals.size === 0) return input;
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const width = removals.get(i);
    if (width === undefined) continue;
    if (i > start) chunks.push(input.slice(start, i));
    start = i + width;
    i = start - 1;
  }
  chunks.push(input.slice(start));
  return chunks.join('');
}
