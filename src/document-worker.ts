/** Fixed document worker entry; accepts text only, returns OOXML bytes, and exposes no filesystem or network tools. */
import { parentPort, workerData } from 'node:worker_threads'
import { renderDocx } from './document-render.ts'

try { parentPort!.postMessage({ bytes: await renderDocx(workerData.title, workerData.body) }) }
catch { parentPort!.postMessage({ error: 'Word 生成失败：正文或表格超出支持范围；未生成替代 TXT。' }) }
