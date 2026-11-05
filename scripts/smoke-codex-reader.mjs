/** Verify the installed native reader against an empty, isolated CODEX_HOME. Never reads the user's history. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { withCodexReader } from '../lib/sync-core.js';
const dir=mkdtempSync(join(tmpdir(),'loom-codex-empty-')),previous=process.env.CODEX_HOME;
process.env.CODEX_HOME=dir;
try {
  const result=await withCodexReader(AbortSignal.timeout(45_000),r=>r.call('thread/list',{limit:10,sourceKinds:['cli','vscode','appServer','unknown'],useStateDbOnly:true}));
  assert.deepEqual(result.data,[]);
  console.log('PASS: installed Codex CLI initialized and returned an empty isolated history; no user sessions or model turns.');
} finally {
  if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;
  // Allow the child shutdown to release Windows file handles before removing this owned fixture.
  await new Promise(r=>setTimeout(r,250));
  if(!resolve(dir).startsWith(resolve(tmpdir())+sep+'loom-codex-empty-'))throw Error('unsafe cleanup');
  rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
