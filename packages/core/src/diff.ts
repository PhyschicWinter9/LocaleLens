/** Minimal LCS line diff for previews. */
export function unifiedDiff(a: string, b: string, ctx = 2): string {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: { t: " " | "-" | "+"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: " ", s: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: "-", s: A[i++] });
    else ops.push({ t: "+", s: B[j++] });
  }
  while (i < n) ops.push({ t: "-", s: A[i++] });
  while (j < m) ops.push({ t: "+", s: B[j++] });
  const keep = new Set<number>();
  ops.forEach((o, k) => { if (o.t !== " ") for (let d = -ctx; d <= ctx; d++) keep.add(k + d); });
  const out: string[] = [];
  let last = -2;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1) out.push("@@");
    out.push(o.t + o.s);
    last = k;
  });
  return out.join("\n");
}
