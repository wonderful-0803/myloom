'use strict'
window.loomOnboarding = (() => {
  const el = id => document.getElementById(id), bridge = window.loomDesktop
  const names = ['本机环境', '模型', '飞书', '消息范围', '检查并启动']
  let step, hydrated = false, current, groupSignature = '', memberSignature = '', operating = false
  const selected = new Map()
  function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node }
  function showStep(value) {
    step = value
    document.querySelectorAll('.setup-page').forEach(page => { page.hidden = Number(page.dataset.step) !== step })
    el('setup-steps').replaceChildren(...names.map((name, index) => {
      const item = text('span', `${index + 1}  ${name}`, index === step ? 'current' : index < (current?.step ?? 0) ? 'done' : '')
      if (index === step) item.setAttribute('aria-current', 'step')
      return item
    }))
  }
  function render(state) {
    current = state
    el('onboarding-panel').hidden = !state?.active
    if (!state?.active) return
    if (!hydrated) {
      hydrated = true; step = state.step
      if (state.model) { el('setup-base').value = state.model.baseURL; el('setup-model').value = state.model.model }
      if (state.bot) el('setup-app-id').value = state.bot.appId
      if (state.scope) {
        el('setup-owner').value = state.scope.owner; el('setup-direct').checked = state.scope.directMessages
        document.querySelector(`input[name="setup-mode"][value="${state.scope.mode === 'auto' ? 'auto' : 'observe'}"]`).checked = true
        for (const group of state.scope.chats) selected.set(group.chatId, group.listen)
      }
    }
    showStep(step)
    el('setup-environment').replaceChildren(...state.environment.map(check => {
      const row = text('div', '', check.available ? 'available' : 'unavailable')
      row.append(text('span', check.name), text('small', check.available ? '已找到' : '待安装')); return row
    }))
    const signature = JSON.stringify(state.groups)
    if (signature !== groupSignature) {
      groupSignature = signature
      el('setup-groups-list').replaceChildren()
      const selector = el('setup-member-chat'), previous = selector.value
      selector.replaceChildren(new Option('从一个群的成员中选择本人…', ''))
      for (const group of state.groups) {
        selector.append(new Option(group.name, group.chatId))
        const row = document.createElement('div'); row.className = 'setup-group'
        const label = document.createElement('label'), checkbox = document.createElement('input')
        checkbox.type = 'checkbox'; checkbox.checked = selected.has(group.chatId); checkbox.dataset.chatId = group.chatId
        label.append(checkbox, text('span', group.name))
        const receive = document.createElement('select'); receive.setAttribute('aria-label', group.name + '的接收范围')
        receive.append(new Option('仅 @ 机器人', 'mentions'), new Option('全部消息（需平台权限）', 'all'))
        receive.value = selected.get(group.chatId) || 'mentions'; receive.disabled = !checkbox.checked
        checkbox.addEventListener('change', () => {
          if (checkbox.checked && selected.size >= 3) { checkbox.checked = false; el('setup-error').textContent = '最多选择 3 个群。'; el('setup-error').hidden = false; return }
          if (checkbox.checked) selected.set(group.chatId, receive.value); else selected.delete(group.chatId)
          receive.disabled = !checkbox.checked
        })
        receive.addEventListener('change', () => { if (checkbox.checked) selected.set(group.chatId, receive.value) })
        row.append(label, receive); el('setup-groups-list').append(row)
      }
      selector.value = previous
      if (!state.groups.length) el('setup-groups-list').append(text('p', '暂未找到已加入的群。可先把机器人加入测试群，再刷新；也可以仅接入本人私聊。', 'setup-note'))
    }
    const members = JSON.stringify(state.members)
    if (members !== memberSignature) {
      memberSignature = members; const select = el('setup-member-select')
      select.replaceChildren(new Option('请选择你本人…', ''), ...state.members.map(member => new Option(member.name, member.id)))
      select.hidden = !state.members.length
    }
    el('setup-review').replaceChildren()
    if (state.model && state.bot && state.scope) {
      const fields = [['模型', state.model.model], ['API 地址', state.model.baseURL], ['飞书机器人', `${state.bot.name} · ${state.bot.appId}`],
        ['唯一可发起任务的人', `${state.scope.ownerName} · ${state.scope.owner}`], ['私聊', state.scope.directMessages ? '接收本人私聊' : '关闭'],
        ['群聊', state.scope.chats.length ? state.scope.chats.map(group => `${group.name}（${group.listen === 'all' ? '全部消息' : '仅 @'}）`).join('、') : '关闭'],
        ['自主处理', state.scope.mode === 'auto' ? '自动执行符合办公规则的本人需求' : '先观察；私聊和明确 @ 可执行'],
        ['设备执行', '以你的系统用户运行办公工具和命令；当前没有系统级沙箱'], ['交付', '回复原飞书对话并保存本地产物；邮箱未连接']]
      for (const [name, value] of fields) { const row = text('div', '', 'setup-review-row'); row.append(text('small', name), text('span', value)); el('setup-review').append(row) }
    }
    el('setup-progress').textContent = (state.busy ? '正在处理 · ' : '') + state.message
    el('setup-error').textContent = state.error || ''; el('setup-error').hidden = !state.error
    el('setup-conflicts').hidden = !state.conflicts.length
    el('setup-conflicts').replaceChildren(...state.conflicts.map(item => text('div', `${item.name} 正在原环境运行（${item.active} 个未完成任务）。请先在原客户端明确停止监听，再回这里启动；原历史保留。`)))
    document.querySelectorAll('#onboarding-panel button, #onboarding-panel input, #onboarding-panel select').forEach(control => { control.disabled = state.busy || operating })
    document.querySelectorAll('.setup-group').forEach(row => { row.querySelector('select').disabled ||= !row.querySelector('input').checked })
    document.querySelectorAll('.setup-back').forEach(button => { button.disabled ||= state.frozen })
    el('setup-start').disabled ||= !el('setup-consent').checked
    el('setup-prepare').disabled ||= state.environment.some(check => !check.available)
    el('setup-choose-engine').disabled ||= state.prepared
  }
  async function action(name, input, advance = false) {
    if (operating) return
    operating = true; if (current) render(current)
    try {
      const result = await bridge.onboarding(name, input)
      if (advance) step = result.onboarding.step
      operating = false; render(result.onboarding)
      window.dispatchEvent(new CustomEvent('loom-onboarding-state', { detail: result }))
    } catch (error) {
      const state = await bridge.state(); operating = false; render(state.onboarding)
      el('setup-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      el('setup-error').hidden = false
    } finally { operating = false }
  }
  el('setup-prepare').addEventListener('click', () => action('prepare', {}, true))
  el('setup-check').addEventListener('click', () => action('environment'))
  el('setup-model-form').addEventListener('submit', event => { event.preventDefault(); void action('model', { baseURL: el('setup-base').value, model: el('setup-model').value, apiKey: el('setup-key').value }, true).finally(() => { el('setup-key').value = '' }) })
  el('setup-provider').addEventListener('change', event => {
    el('setup-base').value = { dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1', deepseek: 'https://api.deepseek.com', custom: '' }[event.target.value]
    if (event.target.value === 'deepseek' && !el('setup-model').value) el('setup-model').value = 'deepseek-flash'
  })
  el('setup-bot-form').addEventListener('submit', event => { event.preventDefault(); void action('bot', { appId: el('setup-app-id').value, appSecret: el('setup-app-secret').value }, true).finally(() => { el('setup-app-secret').value = '' }) })
  el('setup-groups').addEventListener('click', () => action('groups'))
  el('setup-members').addEventListener('click', () => action('members', { chatId: el('setup-member-chat').value }))
  el('setup-member-select').addEventListener('change', event => { if (event.target.value) el('setup-owner').value = event.target.value })
  el('setup-scope-form').addEventListener('submit', event => {
    event.preventDefault()
    void action('scope', { owner: el('setup-owner').value.trim(), directMessages: el('setup-direct').checked,
      chats: [...selected].map(([chatId, listen]) => ({ chatId, listen })), mode: document.querySelector('input[name="setup-mode"]:checked').value }, true)
  })
  document.querySelectorAll('.setup-back').forEach(button => button.addEventListener('click', () => showStep(Math.max(0, step - 1))))
  el('setup-consent').addEventListener('change', () => { if (current) render(current) })
  el('setup-start').addEventListener('click', () => action('start', { consent: el('setup-consent').checked }, true))
  el('setup-console').addEventListener('click', () => bridge.action('feishu-console'))
  el('setup-choose-engine').addEventListener('click', async () => {
    try { const state = await bridge.action('choose-engine'); render(state.onboarding) }
    catch (error) { el('setup-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); el('setup-error').hidden = false }
  })
  return { render }
})()
