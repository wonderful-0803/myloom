/**
 * Demo script - Auto-runs the demo scenario
 * Can be triggered by `pnpm demo`
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

const API_BASE = 'http://localhost:4567/api';

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return response.json();
}

async function waitForServer(maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(`${API_BASE}/health`);
      return true;
    } catch {
      await setTimeout(1000);
    }
  }
  return false;
}

async function runDemo() {
  console.log('\n🎬 Loom Demo Script Starting...\n');

  // Start server
  console.log('🚀 Starting Loom server...');
  const serverProcess = spawn('tsx', ['src/server/index.ts'], {
    stdio: 'inherit',
  });

  // Wait for server to be ready
  console.log('⏳ Waiting for server...');
  const ready = await waitForServer();
  if (!ready) {
    console.error('❌ Server failed to start');
    serverProcess.kill();
    process.exit(1);
  }

  console.log('✅ Server ready!\n');
  await setTimeout(1000);

  try {
    // Step 1: Pin first mandate - "静默复现并修复简单缺陷"
    console.log('📌 Step 1: Pinning mandate "静默复现并修复简单缺陷"');
    await request('/mandates', {
      method: 'POST',
      body: JSON.stringify({
        title: '静默复现并修复简单缺陷',
        description: '自动检测、复现并修复简单的代码缺陷，无需人工介入',
        scope: 'bugfix',
      }),
    });
    await setTimeout(1500);

    // Step 2: IM bug discussion (no @mention)
    console.log('💬 Step 2: Simulating IM bug discussion (no @mention, speculative work)');
    await request('/triggers', {
      method: 'POST',
      body: JSON.stringify({
        sourceKind: 'sim-im',
        type: 'im_message',
        payload: {
          channel: '#dev-chat',
          user: 'Alice',
          message: 'Hey team, users are reporting a crash when submitting empty forms. Should we investigate this?',
        },
        threadTopics: ['IM#dev-chat'],
      }),
    });
    await setTimeout(2000);

    console.log('💬 Step 2b: Follow-up discussion');
    await request('/triggers', {
      method: 'POST',
      body: JSON.stringify({
        sourceKind: 'sim-im',
        type: 'im_message',
        payload: {
          channel: '#dev-chat',
          user: 'Bob',
          message: 'I can reproduce it locally. Looks like a null check is missing in FormValidator.ts',
        },
        threadTopics: ['IM#dev-chat'],
      }),
    });
    await setTimeout(3000);

    // Step 3: CI failure event (passthrough to same ticket)
    console.log('🔴 Step 3: CI failure event (passthrough to existing ticket)');
    await request('/triggers', {
      method: 'POST',
      body: JSON.stringify({
        sourceKind: 'sim-ci',
        type: 'ci_failure',
        payload: {
          build: 'main-branch-build-1234',
          job: 'unit-tests',
          error: 'FormValidator test failed: Cannot read property "value" of null',
          branch: 'main',
        },
        threadTopics: ['CI#main-build', 'IM#dev-chat'],
      }),
    });
    await setTimeout(4000);

    // Step 4: Worker should complete and create artifact
    console.log('⏳ Step 4: Waiting for worker to complete and create artifact...');
    await setTimeout(3000);

    // Step 5: Pin second mandate - "周五技术简报"
    console.log('📌 Step 5: Pinning second mandate "周五技术简报"');
    await request('/mandates', {
      method: 'POST',
      body: JSON.stringify({
        title: '周五技术简报',
        description: '每周五自动生成技术进展简报',
        scope: 'reporting',
      }),
    });
    await setTimeout(1500);

    // Step 6: Clock trigger (true multi-task)
    console.log('⏰ Step 6: Clock trigger for weekly report (parallel work)');
    await request('/triggers', {
      method: 'POST',
      body: JSON.stringify({
        sourceKind: 'sim-clock',
        type: 'weekly_timer',
        payload: {
          trigger: 'friday_report',
          timestamp: Date.now(),
        },
        threadTopics: ['clock#weekly'],
      }),
    });
    await setTimeout(3000);

    // Done
    console.log('\n✨ Demo script complete!\n');
    console.log('🌐 Open http://localhost:4567 in your browser to see the Loom UI');
    console.log('   - Intent Board: See pinned mandates');
    console.log('   - World Bus: See trigger stream with Fast/Slow path filtering');
    console.log('   - Atelier Floor: See Router logs and Worker cards');
    console.log('   - Gallery: See completed artifacts\n');
    console.log('💡 Try injecting more triggers or pinning new mandates!\n');
    console.log('Press Ctrl+C to stop the server.');

    // Keep alive
    process.on('SIGINT', () => {
      console.log('\n👋 Stopping server...');
      serverProcess.kill();
      process.exit(0);
    });

    // Don't exit - keep server running
    await new Promise(() => {});
  } catch (error) {
    console.error('❌ Demo error:', error);
    serverProcess.kill();
    process.exit(1);
  }
}

runDemo();
