/**
 * Real-file sandbox worker helpers
 * Touches /workspace/loom-sandbox to prove Loom is not static-only.
 * R4: Scene A = calc.js divide-zero; Scene B = format.js null guard.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const SANDBOX_ROOT =
  process.env.LOOM_SANDBOX_ROOT || fileURLToPath(new URL('../../../loom-sandbox', import.meta.url));
export const CALC_PATH = path.join(SANDBOX_ROOT, 'src', 'calc.js');
export const FORMAT_PATH = path.join(SANDBOX_ROOT, 'src', 'format.js');

export type SandboxScene = 'A' | 'B';

const FIXED_DIVIDE = `/** FIXED by Loom Worker: reject divide-by-zero */
export function divide(a, b) {
  if (b === 0) {
    throw new Error('Division by zero');
  }
  return a / b;
}
`;

const BAD_DIVIDE = `/** BAD PATCH (forceFail demo) — still no zero guard */
export function divide(a, b) {
  return a / b; // intentionally still buggy
}
`;

const FIXED_FORMAT = `/** FIXED by Loom Worker: null/undefined guard for formatPercent */
export function formatPercent(n) {
  if (n === null || n === undefined || Number.isNaN(n)) {
    return 'n/a';
  }
  return \`\${Number(n).toFixed(1)}%\`;
}

export function formatRatio(a, b) {
  if (b === 0) return 'n/a';
  return formatPercent((a / b) * 100);
}
`;

const BAD_FORMAT = `/** BAD PATCH (forceFail demo) — still no null guard */
export function formatPercent(n) {
  return \`\${n.toFixed(1)}%\`; // intentionally still buggy
}

export function formatRatio(a, b) {
  if (b === 0) return 'n/a';
  return formatPercent((a / b) * 100);
}
`;

export interface SandboxFixResult {
  sandboxRoot: string;
  calcPath: string;
  filePath: string;
  relativeFile: string;
  scene: SandboxScene;
  before: string;
  after: string;
  diffSummary: string;
  testBefore: { ok: boolean; output: string; exitCode: number };
  testAfter: { ok: boolean; output: string; exitCode: number };
  patched: boolean;
  reproCommand: string;
}

async function runTests(
  testFile: string
): Promise<{ ok: boolean; output: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', ['--test', testFile], {
      cwd: SANDBOX_ROOT,
      timeout: 15000,
    });
    return { ok: true, output: `${stdout}\n${stderr}`.trim(), exitCode: 0 };
  } catch (err: any) {
    const output = `${err.stdout || ''}\n${err.stderr || err.message || ''}`.trim();
    const exitCode = typeof err.code === 'number' ? err.code : 1;
    return { ok: false, output, exitCode };
  }
}

function extractFn(src: string, name: string): string {
  const re = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  return m ? m[0] : `(${name} not found)`;
}

function applyReplace(
  src: string,
  patterns: RegExp[],
  replacement: string
): string {
  for (const re of patterns) {
    const next = src.replace(re, replacement.trimEnd());
    if (next !== src) return next;
  }
  return src;
}

function applyDivideReplace(src: string, replacement: string): string {
  return applyReplace(
    src,
    [
      /\/\*\* BUG:[\s\S]*?export function divide\([\s\S]*?\n\}/,
      /\/\*\* FIXED by Loom Worker:[\s\S]*?export function divide\([\s\S]*?\n\}/,
      /\/\*\* BAD PATCH[\s\S]*?export function divide\([\s\S]*?\n\}/,
      /export function divide\([\s\S]*?\n\}/,
    ],
    replacement
  );
}

function applyFormatReplace(src: string, replacement: string): string {
  // Replace whole file content for format.js (small module)
  if (/export function formatPercent/.test(src)) {
    return replacement.trimEnd() + '\n';
  }
  return src;
}

/**
 * Reproduce bug, patch file, re-run tests.
 * scene A: calc.js divide-zero; scene B: format.js null guard.
 */
export async function reproduceAndPatchSandbox(
  opts: { forceFail?: boolean; scene?: SandboxScene } = {}
): Promise<SandboxFixResult> {
  const scene: SandboxScene = opts.scene === 'B' ? 'B' : 'A';
  const filePath = scene === 'B' ? FORMAT_PATH : CALC_PATH;
  const relativeFile = scene === 'B' ? 'src/format.js' : 'src/calc.js';
  const testFile = scene === 'B' ? 'src/format.test.js' : 'src/calc.test.js';
  const reproCommand = `cd loom-sandbox && node --test ${testFile}`;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Sandbox file missing at ${filePath}`);
  }

  const beforeFull = fs.readFileSync(filePath, 'utf8');
  const beforeFn =
    scene === 'B' ? extractFn(beforeFull, 'formatPercent') : extractFn(beforeFull, 'divide');

  const alreadyPatched =
    scene === 'B'
      ? /n\/a|null \/\/|=== null/.test(beforeFn)
      : /Division by zero|除以零/.test(beforeFn);

  const testBefore = await runTests(testFile);

  let afterFull = beforeFull;
  let patched = false;

  if (opts.forceFail) {
    afterFull =
      scene === 'B'
        ? applyFormatReplace(beforeFull, BAD_FORMAT)
        : applyDivideReplace(beforeFull, BAD_DIVIDE);
    if (afterFull === beforeFull) {
      throw new Error(`Failed to locate target for forceFail patch (${scene})`);
    }
    fs.writeFileSync(filePath, afterFull, 'utf8');
    patched = true;
  } else if (!alreadyPatched) {
    afterFull =
      scene === 'B'
        ? applyFormatReplace(beforeFull, FIXED_FORMAT)
        : applyDivideReplace(beforeFull, FIXED_DIVIDE);
    if (afterFull === beforeFull) {
      throw new Error(`Failed to locate target for patch (${scene})`);
    }
    fs.writeFileSync(filePath, afterFull, 'utf8');
    patched = true;
  }

  const afterFn =
    scene === 'B' ? extractFn(afterFull, 'formatPercent') : extractFn(afterFull, 'divide');
  const testAfter = await runTests(testFile);

  const diffSummary = [
    `--- ${relativeFile} (before)`,
    beforeFn,
    `+++ ${relativeFile} (after)`,
    afterFn,
  ].join('\n');

  return {
    sandboxRoot: SANDBOX_ROOT,
    calcPath: CALC_PATH,
    filePath,
    relativeFile,
    scene,
    before: beforeFn,
    after: afterFn,
    diffSummary,
    testBefore,
    testAfter,
    patched,
    reproCommand,
  };
}

/** Reset sandbox Scene A + Scene B to buggy state for re-demo */
export function resetSandboxBug(): void {
  const buggyCalc = `/**
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

/** BUG: missing zero divisor guard */
export function divide(a, b) {
  return a / b;
}

export function safeDivide(a, b) {
  // placeholder — Worker may redirect callers here after patch
  return divide(a, b);
}
`;
  fs.writeFileSync(CALC_PATH, buggyCalc, 'utf8');

  const buggyFormat = `/**
 * loom-sandbox — intentional buggy formatter (Scene B)
 * Bug: formatPercent(null) throws TypeError (no null guard).
 * Loom 规则补丁 Worker patches this file for「场景 B」demo.
 */
export function formatPercent(n) {
  // BUG: no null/undefined guard — n.toFixed throws
  return \`\${n.toFixed(1)}%\`;
}

export function formatRatio(a, b) {
  if (b === 0) return 'n/a';
  return formatPercent((a / b) * 100);
}
`;
  fs.writeFileSync(FORMAT_PATH, buggyFormat, 'utf8');
}
