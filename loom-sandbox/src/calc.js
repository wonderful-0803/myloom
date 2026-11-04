/**
 * loom-sandbox — intentional buggy calculator (Scene A)
 * Bug: divide() crashes / returns Infinity when b === 0 (no guard).
 * Loom 规则补丁 Worker patches this file when Feishu bug-report flow runs (规则补丁).
 */
export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

/** BAD PATCH (forceFail demo) — still no zero guard */
export function divide(a, b) {
  return a / b; // intentionally still buggy
}

export function safeDivide(a, b) {
  // placeholder — Worker may redirect callers here after patch
  return divide(a, b);
}
