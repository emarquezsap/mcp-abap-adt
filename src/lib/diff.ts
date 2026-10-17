/**
 * Minimal unified line diff. Common prefix/suffix are trimmed first, the
 * remaining middle part is aligned with an LCS table (bounded size).
 */
const MAX_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

export function diffLines(oldText: string, newText: string, loose = false): Op[] | undefined {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  // optional loose comparison: case and whitespace insensitive (pretty printer changes)
  const norm = (l: string) => (loose ? l.toUpperCase().replace(/\s+/g, " ").trim() : l);
  const ka = a.map(norm);
  const kb = b.map(norm);
  let start = 0;
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: " ", line: b[i], a: i + 1, b: i + 1 });

  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) return undefined;
  // LCS lengths from the end, rows of Uint32Array
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        ka[start + i] === kb[start + j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[start + i] === kb[start + j]) {
      ops.push({ kind: " ", line: b[start + j], a: start + i + 1, b: start + j + 1 });
      i++;
      j++;
    } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) {
      ops.push({ kind: "-", line: a[start + i], a: start + i + 1, b: start + j });
      i++;
    } else {
      ops.push({ kind: "+", line: b[start + j], a: start + i, b: start + j + 1 });
      j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    ops.push({ kind: " ", line: b[endB + k], a: endA + k + 1, b: endB + k + 1 });
  }
  return ops;
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  context = 3,
  loose = false,
): { diff: string; added: number; removed: number } | undefined {
  const ops = diffLines(oldText, newText, loose);
  if (!ops) return undefined;
  const added = ops.filter((o) => o.kind === "+").length;
  const removed = ops.filter((o) => o.kind === "-").length;
  if (!added && !removed) return { diff: "", added, removed };

  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  const changed = ops.map((o, idx) => (o.kind !== " " ? idx : -1)).filter((x) => x >= 0);
  let k = 0;
  while (k < changed.length) {
    let from = Math.max(0, changed[k] - context);
    let to = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= to + 1) {
      k++;
      to = Math.min(ops.length - 1, changed[k] + context);
    }
    const hunk = ops.slice(from, to + 1);
    const aStart = hunk.find((o) => o.kind !== "+")?.a ?? hunk[0].a;
    const bStart = hunk.find((o) => o.kind !== "-")?.b ?? hunk[0].b;
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.line}`);
    k++;
  }
  return { diff: out.join("\n"), added, removed };
}
