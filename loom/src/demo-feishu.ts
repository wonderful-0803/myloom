/**
 * Feishu-shaped demo (R7): reset → demo:feishu → assert timeline sceneLabel + audit MD 1…5 + 409
 * Usage: pnpm demo:feishu
 */

import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs';

const API = 'http://localhost:4567/api';
const VERSION = '1.10.0-r10';

async function healthy() {
  try {
    const r = await fetch(`${API}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('\n🎬 Loom R7 · 真接飞书 + 冷启动 UI Demo（sceneLabel · audit 1…5 · 409 回归）\n');

  let child: ReturnType<typeof spawn> | null = null;
  if (!(await healthy())) {
    console.log('🚀 Starting server...');
    child = spawn('tsx', ['src/server/index.ts'], { stdio: 'inherit', cwd: process.cwd() });
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await healthy()) break;
    }
    if (!(await healthy())) {
      console.error('Server failed to start');
      child?.kill();
      process.exit(1);
    }
  } else {
    console.log('✅ Reusing existing server on :4567');
  }

  const health = await (await fetch(`${API}/health`)).json();
  console.log('❤️ Health:', health);
  if (health.version !== VERSION) {
    console.warn(`⚠️ Expected version ${VERSION} — restart server if still on older build`);
  }

  const before = fs.readFileSync('/workspace/loom-sandbox/src/calc.js', 'utf8');
  console.log('📦 Sandbox divide() before:\n', before.match(/export function divide[\s\S]*?\n\}/)?.[0]);

  await fetch(`${API}/demo/reset`, { method: 'POST' });
  const res = await fetch(`${API}/demo/feishu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true, scene: 'A' }),
  });
  const body = await res.json();
  console.log('📣 Demo API:', body);

  const dup = await fetch(`${API}/demo/feishu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true, scene: 'A' }),
  });
  const dupBody = await dup.json().catch(() => ({}));
  console.log('🔒 Duplicate during lock:', dup.status, dupBody);
  if (dup.status !== 409) {
    console.error('Expected HTTP 409 while demoLock active');
    if (child) child.kill();
    process.exit(1);
  }

  console.log('⏳ Waiting for worker / 四源注入...');
  await sleep(9000);

  const after = fs.readFileSync('/workspace/loom-sandbox/src/calc.js', 'utf8');
  console.log('📦 Sandbox divide() after:\n', after.match(/export function divide[\s\S]*?\n\}/)?.[0]);

  const tickets = await (await fetch(`${API}/tickets`)).json();
  console.log(`🎫 Tickets (${tickets.length}):`);
  for (const t of tickets) {
    console.log(`   - [${t.status}] ${t.title}`);
  }

  const arts = await (await fetch(`${API}/artifacts`)).json();
  console.log(`🖼️ Artifacts: ${arts.length}`);
  for (const a of arts) {
    console.log(`   - [${a.type}] ${a.title}`);
    console.log(`     summary: ${a.summary}`);
  }

  const acks = await (await fetch(`${API}/feishu/acks`)).json();
  console.log(`🤖 Feishu ACKs: ${acks.length}`);
  for (const a of acks) {
    console.log(`   - [${a.kind}] ${a.text}`);
  }

  const tl = await (await fetch(`${API}/demo/timeline`)).json();
  console.log('🧭 Timeline runId:', tl.runId);
  console.log('🧭 Scene:', tl.scene, 'sceneLabel:', tl.sceneLabel);
  console.log('🧭 Conclusion:', tl.conclusion);
  console.log(
    '🧭 Steps:',
    JSON.stringify(tl.steps?.map((s: any) => `${s.id}:${s.status}:${s.detail}`))
  );
  console.log('🧭 primaryArtifactId:', tl.primaryArtifactId);

  const fails: string[] = [];

  if (health.version !== VERSION) fails.push(`health.version want ${VERSION} got ${health.version}`);
  if (!tl.runId || tl.runId === 'live') fails.push(`timeline.runId must be real id, got ${tl.runId}`);
  if (tl.scene && tl.scene !== 'A') fails.push(`expected scene A for this run, got ${tl.scene}`);
  if (tl.sceneLabel !== '场景 A · calc.js') {
    fails.push(`timeline.sceneLabel want 场景 A · calc.js got ${tl.sceneLabel}`);
  }
  const details = (tl.steps || []).map((s: any) => `${s.detail || ''} ${s.label || ''}`).join(' ');
  if (/审批通过|技术简报|日历|周报提纲/.test(details) && !/除零|divide|Infinity|calc|报障|值班|测绿|缺陷/.test(details)) {
    fails.push('timeline steps look hijacked by non-primary story');
  }
  for (const s of tl.steps || []) {
    if (/审批通过变更|技术简报|日历提醒|文档评论/.test(s.detail || '')) {
      fails.push(`step ${s.id} detail polluted: ${s.detail}`);
    }
  }
  for (const a of acks) {
    if ((a.kind === 'brief' || a.kind === 'note') && /已修复/.test(a.text)) {
      fails.push(`kind=${a.kind} still says 已修复: ${a.text}`);
    }
  }
  const defectArts = arts.filter(
    (a: any) => a.type === 'pr_note' || /缺陷修复/.test(a.title || '')
  );
  if (defectArts.length !== 1) {
    fails.push(`expected exactly 1 defect-fix artifact, got ${defectArts.length}`);
  }
  if (tl.primaryArtifactId && defectArts[0] && tl.primaryArtifactId !== defectArts[0].id) {
    fails.push('primaryArtifactId mismatch vs sole defect artifact');
  }
  const gallery = (tl.steps || []).find((s: any) => s.id === 'gallery');
  if (gallery && defectArts[0] && gallery.refId !== defectArts[0].id) {
    fails.push(`gallery.refId ${gallery.refId} != defect art ${defectArts[0].id}`);
  }
  if (!tl.conclusion || !/值班群报障/.test(tl.conclusion)) {
    fails.push(`missing/bad conclusion: ${tl.conclusion}`);
  }
  if (tl.conclusion && !/calc\.js/.test(tl.conclusion)) {
    fails.push(`conclusion should mention calc.js for scene A: ${tl.conclusion}`);
  }
  const briefTitles = arts.filter((a: any) => a.type === 'brief').map((a: any) => a.title);
  if (new Set(briefTitles).size !== briefTitles.length) {
    fails.push(`duplicate brief titles: ${JSON.stringify(briefTitles)}`);
  }
  for (const need of ['文档催更：站会材料清单', '日历触发：周五站会简报', '审批通过：生产发布变更说明']) {
    if (!briefTitles.includes(need)) fails.push(`missing distinct brief title: ${need}`);
  }
  if (defectArts[0] && !/复现:.*node --test|exit \d/.test(defectArts[0].summary || '')) {
    fails.push(`defect summary missing repro/exit: ${defectArts[0].summary}`);
  }
  if (!tl.primaryTicketId) fails.push('missing primaryTicketId');
  if (!/Division by zero|b === 0/.test(after)) {
    fails.push('sandbox calc.js missing divide-by-zero guard after demo');
  }

  // Audit pack
  const auditJson = await (await fetch(`${API}/demo/audit?format=json`)).json();
  fs.writeFileSync('/tmp/loom-audit-r6.json', JSON.stringify(auditJson, null, 2));
  const auditMdRes = await fetch(`${API}/demo/audit?format=md`);
  const auditMd = await auditMdRes.text();
  fs.writeFileSync('/tmp/loom-audit-r6.md', auditMd);
  console.log('📦 Audit JSON keys:', Object.keys(auditJson));
  console.log('📦 Audit MD bytes:', auditMd.length);

  if (auditJson.version !== VERSION) fails.push(`audit.version ${auditJson.version}`);
  if (auditJson.runId !== tl.runId) fails.push(`audit.runId mismatch ${auditJson.runId} vs ${tl.runId}`);
  if (auditJson.workerMode !== 'deterministic-rule-patch') fails.push('audit.workerMode wrong');
  if (auditJson.sandboxPath !== '/workspace/loom-sandbox') fails.push('audit.sandboxPath wrong');
  if (!auditJson.reproCommand || !/node --test/.test(auditJson.reproCommand)) {
    fails.push(`audit.reproCommand bad: ${auditJson.reproCommand}`);
  }
  if (!auditJson.primaryTicket?.title) fails.push('audit missing primaryTicket');
  if (!auditJson.primaryArtifact?.title) fails.push('audit missing primaryArtifact');
  if (!Array.isArray(auditJson.acks) || auditJson.acks.length < 2) {
    fails.push(`audit.acks too few: ${auditJson.acks?.length}`);
  }
  if (!auditJson.timeline?.steps || auditJson.timeline.steps.length < 5) {
    fails.push('audit.timeline steps < 5');
  }
  if (auditJson.sceneLabel !== '场景 A · calc.js') {
    fails.push(`audit.sceneLabel want 场景 A · calc.js got ${auditJson.sceneLabel}`);
  }
  if (auditJson.sceneLabel !== tl.sceneLabel) {
    fails.push(`audit.sceneLabel !== timeline.sceneLabel (${auditJson.sceneLabel} vs ${tl.sceneLabel})`);
  }
  for (const needle of ['runId', '五步时间线', 'ACK', '复现命令', '主故事', auditJson.runId, '诚实边界']) {
    if (!auditMd.includes(String(needle))) fails.push(`audit MD missing "${needle}"`);
  }
  // numbered 1. … 5. in source (not all "1.")
  for (let n = 1; n <= 5; n++) {
    if (!auditMd.includes(`\n${n}. **`)) {
      fails.push(`audit MD missing numbered step "${n}. **"`);
    }
  }
  // Must NOT have five identical "1. **" only — detect if step 2-5 missing already covered
  const numbered = [...auditMd.matchAll(/^\d+\. \*\*/gm)].map((m) => m[0]);
  console.log('🔢 MD step markers:', numbered);
  if (numbered.length < 5) fails.push(`expected ≥5 numbered steps in MD, got ${numbered.length}`);

  const fixedAck = acks.find((a: any) => a.kind === 'fixed');
  if (fixedAck && !auditMd.includes(fixedAck.text.slice(0, 12))) {
    fails.push('audit MD missing fixed ACK snippet');
  }
  if (!auditMd.includes('可对外演示的技术验证 demo')) {
    fails.push('audit MD missing closing declaration');
  }

  // stakeholder doc exists
  if (!fs.existsSync('/workspace/loom/docs/stakeholder-demo.md')) {
    fails.push('missing docs/stakeholder-demo.md');
  }

  const ch = await fetch(`${API}/feishu/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', challenge: 'loom-r6' }),
  });
  console.log('🔐 url_verification:', await ch.json());

  if (fails.length) {
    console.error('\n❌ R7 ASSERTIONS FAILED:');
    for (const f of fails) console.error('  -', f);
    if (child) child.kill();
    process.exit(1);
  }

  console.log('\n✅ R10 assertions passed');
  console.log('📄 Audit files: /tmp/loom-audit-r6.json , /tmp/loom-audit-r6.md');
  console.log('🌐 UI: http://localhost:4567');
  console.log('Press Ctrl+C to stop (if this script started the server).\n');

  if (child) {
    process.on('SIGINT', () => {
      child?.kill();
      process.exit(0);
    });
    await new Promise(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
