// Line-level change counts between two blobs (what GitHub reports as a file's additions and
// deletions), via Myers' O(ND) shortest edit script over the lines that differ after trimming the
// common prefix and suffix. Very large edits fall back to a multiset count to bound the work.

function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const MAX_EDIT_STEPS = 4000;

export function lineChanges(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { additions: m, deletions: n };
  const d = shortestEdit(a, start, n, b, start, m);
  if (d === null) return multisetCount(a.slice(start, endA), b.slice(start, endB));
  // d = insertions + deletions and m - n = insertions - deletions
  const additions = (d + m - n) / 2;
  return { additions, deletions: d - additions };
}

function shortestEdit(a: string[], a0: number, n: number, b: string[], b0: number, m: number): number | null {
  const max = Math.min(n + m, MAX_EDIT_STEPS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return null;
}

function multisetCount(a: string[], b: string[]): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const c = counts.get(line) ?? 0;
    if (c > 0) { counts.set(line, c - 1); common++; }
  }
  return { additions: b.length - common, deletions: a.length - common };
}
