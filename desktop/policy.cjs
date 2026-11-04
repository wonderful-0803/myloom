'use strict'
const { pathToFileURL } = require('node:url')
const path = require('node:path')

/** Only the existing personal loopback service is a valid desktop target. */
function serviceURL(value = 'http://127.0.0.1:3082') {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('仅支持本机 127.0.0.1 服务地址。')
  return url.origin
}
function workspaceURL(base, page = 'overview') {
  const pages = ['overview', 'tasks', 'drafts', 'deliverables', 'events', 'rules', 'connection']
  return `${serviceURL(base)}/orchestrator/loom/#${pages.includes(page) ? page : 'overview'}`
}
function workspaceNavigation(value, base) {
  try { const url = new URL(value); return url.origin === serviceURL(base) && url.pathname === '/orchestrator/loom/' && !url.search && !url.username && !url.password }
  catch { return false }
}
function workspaceRequest(value, base) {
  try {
    const url = new URL(value)
    if (url.protocol === 'blob:') return url.origin === serviceURL(base)
    return url.origin === serviceURL(base) && !url.username && !url.password
      && (url.pathname === '/orchestrator/loom/' || url.pathname.startsWith('/orchestrator/loom/assets/') || url.pathname === '/orchestrator/api/loom' || url.pathname.startsWith('/orchestrator/api/loom/'))
  } catch { return false }
}
function localShell(value, shellFile) {
  try { const url = new URL(value); url.hash = ''; return url.href === pathToFileURL(shellFile).href }
  catch { return false }
}
/** Never open file:, custom schemes, credential-bearing or local-network URLs from task content. */
function externalLink(value) {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return false
    return true
  } catch { return false }
}
function downloadName(value) { return path.basename(value).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(-120) || 'result.txt' }
function notificationChanges(before, after) {
  if (!before) return []
  const old = new Map(before.tasks.map(task => [task.id, task]))
  return after.tasks.flatMap(task => {
    const previous = old.get(task.id)
    if (!previous) return []
    if (!previous.completed && task.completed) return [{ title: 'Loom · 任务已完成', body: task.title.slice(0, 100), page: 'deliverables' }]
    if (previous.status !== 'blocked' && task.status === 'blocked') return [{ title: 'Loom · 有任务需要你处理', body: task.title.slice(0, 100), page: 'tasks' }]
    return []
  }).slice(0, 3)
}
module.exports = { serviceURL, workspaceURL, workspaceNavigation, workspaceRequest, localShell, externalLink, downloadName, notificationChanges }
