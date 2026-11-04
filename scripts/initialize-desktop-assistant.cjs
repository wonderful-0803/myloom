#!/usr/bin/env node
// Fixed local bootstrap used by the native onboarding controller. Input contains no secrets.
'use strict'
const { pathToFileURL } = require('node:url')
const path = require('node:path')
async function main() {
  let text = ''
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 32768) throw new Error('Input too large') }
  const { initializePersonalSettings } = await import(pathToFileURL(path.resolve(__dirname, '../lib/personal-setup.js')).href)
  initializePersonalSettings(JSON.parse(text))
  process.stdout.write('{"initialized":true}\n')
}
main().catch(() => { process.stderr.write('本机助手初始化未完成；已有任务库未覆盖。\n'); process.exitCode = 1 })
