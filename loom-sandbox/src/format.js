/**
 * loom-sandbox — intentional buggy formatter (Scene B)
 * Bug: formatPercent(null) throws TypeError (no null guard).
 * Loom 规则补丁 Worker patches this file for「场景 B」demo.
 */
export function formatPercent(n) {
  // BUG: no null/undefined guard — n.toFixed throws
  return `${n.toFixed(1)}%`;
}

export function formatRatio(a, b) {
  if (b === 0) return 'n/a';
  return formatPercent((a / b) * 100);
}
