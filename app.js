'use strict'
;(() => {
  const $ = s => document.querySelector(s)
  const $$ = s => [...document.querySelectorAll(s)]

  const ui = {
    edition: 'java',
    filter: 'all',
    state: 'idle',
    status: { online: false },
    logs: [],
    chat: [],
    settings: null,
    connection: null,
    editing: false,
    authPrompt: null
  }

  // ---------- API ----------
  async function api (path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-minepilot': '1' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    })
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok) {
      const e = new Error((data && data.error) || `Request failed (${res.status})`)
      e.status = res.status
      e.field = data && data.field
      throw e
    }
    return data
  }

  // ---------- boot / gate ----------
  async function boot () {
    let s
    try { s = await api('/session') } catch { s = { authenticated: false } }
    if (!s.authenticated && s.localAutoLogin) {
      try { await api('/session', { method: 'POST', body: {} }); s.authenticated = true } catch {}
    }
    if (!s.authenticated) {
      const key = new URLSearchParams(location.search).get('key')
      if (key) {
        try { await api('/session', { method: 'POST', body: { key } }); s.authenticated = true; history.replaceState(null, '', location.pathname) } catch {}
      }
    }
    if (!s.authenticated) { $('#gate').hidden = false; return }
    start()
  }

  $('#gateForm').addEventListener('submit', async e => {
    e.preventDefault()
    $('#gateErr').textContent = ''
    try {
      await api('/session', { method: 'POST', body: { key: $('#gateKey').value } })
      $('#gate').hidden = true
      start()
    } catch (err) { $('#gateErr').textContent = err.message }
  })

  async function start () {
    $('#app').hidden = false
    setTab('assistant')
    try {
      const v = await api('/versions')
      ui.versions = v
      fillVersions()
    } catch {}
    try {
      const snap = await api('/state')
      applySnapshot(snap)
    } catch (e) {
      if (e.status === 401) return location.reload()
    }
    openSocket()
  }

  // ---------- websocket ----------
  let ws; let wsDelay = 1000
  function openSocket () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/ws`)
    ws.onopen = () => { wsDelay = 1000 }
    ws.onmessage = ev => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      handle(m)
    }
    ws.onclose = () => {
      setPill('error', 'Dashboard offline')
      setTimeout(async () => {
        try { await api('/session'); openSocket() } catch { setTimeout(openSocket, wsDelay) }
      }, wsDelay)
      wsDelay = Math.min(wsDelay * 2, 15000)
    }
  }

  function handle (m) {
    switch (m.type) {
      case 'snapshot': applySnapshot(m.data); break
      case 'log': ui.logs.push(m.entry); if (ui.logs.length > 600) ui.logs.shift(); appendLog(m.entry); break
      case 'chat': ui.chat.push(m.entry); appendChat(m.entry); break
      case 'state': ui.state = m.state; ui.detail = m.detail; ui.reconnect = m.reconnect; renderState(); break
      case 'status': ui.status = m.status; renderStatus(); renderState(); break
      case 'auth': ui.authPrompt = m.auth; renderAuth(); break
      case 'msa': showMsa(m.msa); break
      case 'settings': ui.settings = m.settings; break
    }
  }

  function applySnapshot (s) {
    ui.state = s.state; ui.detail = s.detail; ui.reconnect = s.reconnect
    ui.status = s.status || { online: false }
    ui.logs = s.logs || []; ui.chat = s.chat || []
    ui.settings = s.settings; ui.connection = s.connection
    ui.authPrompt = s.authPrompt
    if (s.connection && !ui.formTouched) fillForm(s.connection)
    renderLogs(); renderChat(); renderStatus(); renderState(); renderAuth()
    if (s.msa) showMsa(s.msa)
  }

  // ---------- connection form ----------

  function fillVersions () {
    const sel = $('#version')
    const cur = sel.value
    const list = ui.versions ? ui.versions.java : []
    sel.innerHTML = ''
    const auto = document.createElement('option'); auto.value = 'auto'; auto.textContent = 'Auto-detect'; sel.appendChild(auto)
    for (const v of list) { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o) }
    sel.value = list.includes(cur) ? cur : 'auto'
  }

  function fillForm (c) {
    $('#host').value = c.host || ''
    $('#port').value = c.port || ''
    $('#username').value = c.username || ''
    $('#auth').value = c.auth || 'offline'
    fillVersions()
    $('#version').value = c.version || 'auto'
  }

  ;['#host', '#port', '#username', '#version', '#auth'].forEach(s => $(s).addEventListener('input', () => { ui.formTouched = true; $(s).removeAttribute('aria-invalid') }))

  function formValues () {
    return {
      edition: 'java',
      host: $('#host').value.trim(),
      port: $('#port').value.trim(),
      username: $('#username').value.trim(),
      version: $('#version').value,
      auth: $('#auth').value
    }
  }

  function clientValidate (v) {
    if (!v.host) return ['host', 'Enter the server address.']
    if (v.port && !/^\d{1,5}$/.test(v.port)) return ['port', 'Port must be a number.']
    if (v.auth !== 'microsoft') {
      if (!v.username) return ['username', 'Enter a bot username.']
      if (!/^[A-Za-z0-9_]{3,16}$/.test(v.username)) return ['username', 'Java usernames are 3-16 characters: letters, numbers and _ only.']
    }
    return null
  }

  $('#connForm').addEventListener('submit', async e => {
    e.preventDefault()
    const v = formValues()
    $('#connErr').textContent = ''
    const bad = clientValidate(v)
    if (bad) { showFieldErr(bad[0], bad[1]); return }
    busy(true)
    try {
      await api('/connect', { method: 'POST', body: v })
      ui.editing = false
      ui.formTouched = false
      ui.connection = v
    } catch (err) { showFieldErr(err.field, err.message) } finally { busy(false) }
  })

  function showFieldErr (field, msg) {
    $('#connErr').textContent = msg
    const el = field && $('#' + field)
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus() }
  }

  $('#btnDisconnect').addEventListener('click', async () => {
    busy(true)
    try { await api('/disconnect', { method: 'POST' }) } catch (e) { $('#connErr').textContent = e.message } finally { busy(false) }
  })
  $('#btnReconnect').addEventListener('click', async () => {
    busy(true)
    try { await api('/reconnect', { method: 'POST' }) } catch (e) { $('#connErr').textContent = e.message } finally { busy(false) }
  })
  $('#btnEdit').addEventListener('click', () => { ui.editing = true; renderState(); $('#host').focus() })

  let isBusy = false
  function busy (b) { isBusy = b; renderState() }

  // ---------- state ----------
  const STATE_LABEL = { idle: 'Offline', offline: 'Offline', connecting: 'Connecting…', online: 'Online', error: 'Error' }
  function setPill (state, text) {
    $('#pill').dataset.state = state
    $('#pillText').textContent = text
  }

  function renderState () {
    const st = ui.state
    let label = STATE_LABEL[st] || st
    if (ui.reconnect) label = `Retrying ${ui.reconnect.attempt}/${ui.reconnect.max}`
    setPill(ui.reconnect ? 'connecting' : st, label)
    const live = st === 'online' || st === 'connecting' || !!ui.reconnect
    $('#btnConnect').disabled = isBusy || st === 'connecting'
    $('#btnConnect').textContent = st === 'connecting' ? 'Connecting…' : 'Connect'
    $('#btnDisconnect').disabled = isBusy || !live
    $('#btnReconnect').disabled = isBusy || !ui.connection || st === 'connecting'
    const summary = st === 'online' && !ui.editing && ui.connection
    $('#connSummary').hidden = !summary
    $('#connFields').hidden = !!summary
    $('#btnConnect').hidden = !!summary
    if (summary) {
      const c = ui.connection
      const s = ui.status || {}
      $('#connSummaryText').innerHTML = ''
      const t = document.createElement('span')
      t.append('Connected to ')
      const b = document.createElement('b'); b.textContent = `${c.host}:${c.port}`; t.append(b)
      t.append(` as ${s.username || c.username}`)
      $('#connSummaryText').append(t)
    }
    let line = ''
    const info = ui.status && ui.status.serverInfo
    if (st === 'error' && ui.detail) line = ''
    if (info && (st === 'online' || st === 'connecting')) {
      line = `${info.versionName ? (/^[\d.]+$/.test(info.versionName) ? 'Minecraft ' : '') + info.versionName : ''}${info.playersOnline != null ? ` · ${info.playersOnline}/${info.playersMax} players at join` : ''}${info.motd ? ` · ${info.motd}` : ''}`
    }
    $('#serverLine').textContent = line
    if (st === 'error' && ui.detail && !$('#connErr').textContent) $('#connErr').textContent = ui.detail
    if (st === 'online' || st === 'connecting') $('#connErr').textContent = ''
  }

  // ---------- status / inventory ----------
  function fmtMode (m) { return m == null ? '—' : String(m).replace(/^\w/, c => c.toUpperCase()) }
  function renderStatus () {
    const s = ui.status || {}
    const dl = $('#stats')
    dl.innerHTML = ''
    $('#statsEmpty').hidden = !!s.online
    const tag = $('#taskTag')
    tag.hidden = !(s.online && s.task)
    tag.textContent = s.task || ''
    tag.title = s.task || ''
    $('#btnStop').hidden = !(s.online && s.task)
    if (s.online) {
      const add = (k, v, cls, bar) => {
        const d = document.createElement('div'); if (cls) d.className = cls
        const dt = document.createElement('dt'); dt.textContent = k
        const dd = document.createElement('dd'); dd.textContent = v
        d.append(dt, dd)
        if (bar != null) { const b = document.createElement('div'); b.className = 'bar'; const sp = document.createElement('span'); sp.style.width = Math.max(0, Math.min(100, bar)) + '%'; b.append(sp); d.append(b) }
        dl.append(d)
      }
      add('Health', s.health != null ? `${s.health} / 20` : '—', null, s.health != null ? s.health * 5 : null)
      add('Food', s.food != null ? `${s.food} / 20` : '—', null, s.food != null ? s.food * 5 : null)
      add('Mode', fmtMode(s.gameMode))
      add('Position', s.position ? `${s.position.x}, ${s.position.y}, ${s.position.z}` : '—', 'two')
      add('World', s.dimension != null ? String(s.dimension).replace('minecraft:', '') : '—')
      add('Players', s.players ? (s.players.length ? s.players.join(', ') : 'Only the bot') : '—', 'wide')
      add('Holding', s.held ? s.held.replace(/_/g, ' ') : 'Nothing', 'two')
      if (s.ping != null) add('Ping', `${s.ping} ms`)
    }
    const inv = s.online ? (s.inventory || []) : []
    const ul = $('#inv'); ul.innerHTML = ''
    for (const it of inv) {
      const li = document.createElement('li')
      const n = document.createElement('span'); n.textContent = it.displayName || it.name.replace(/_/g, ' ')
      const c = document.createElement('b'); c.textContent = it.count
      li.append(n, c); ul.append(li)
    }
    $('#invEmpty').hidden = inv.length > 0
    $('#invEmpty').textContent = s.online ? 'The inventory is empty.' : 'Connect the bot to see its inventory.'
    $('#invCount').textContent = s.online && inv.length ? `${inv.reduce((a, b) => a + b.count, 0)} items` : ''
  }

  // ---------- assistant chat ----------
  function timeStr (at) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  function renderChat () {
    const box = $('#chat'); box.innerHTML = ''
    if (!ui.chat.length) {
      const p = document.createElement('p'); p.className = 'chat-empty'
      p.textContent = 'Connect the bot, then tell it what to do — e.g. "follow Steve", "collect wood", "craft sticks".'
      box.append(p)
      return
    }
    ui.chat.forEach((m, i) => box.append(chatEl(m, i === ui.chat.length - 1)))
    box.scrollTop = box.scrollHeight
  }
  function chatEl (m, isLast) {
    const d = document.createElement('div')
    d.className = `msg ${m.role}${m.ask ? ' ask' : ''}`
    d.textContent = m.text
    if (m.ask && isLast && ui.status && ui.status.pending) {
      const yn = document.createElement('div'); yn.className = 'yn'
      const y = document.createElement('button'); y.className = 'btn primary sm'; y.type = 'button'; y.textContent = 'Yes'
      const n = document.createElement('button'); n.className = 'btn sm'; n.type = 'button'; n.textContent = 'No'
      y.onclick = () => { yn.remove(); send('yes') }
      n.onclick = () => { yn.remove(); send('no') }
      yn.append(y, n); d.append(yn)
    }
    const t = document.createElement('time'); t.textContent = timeStr(m.at); d.append(t)
    return d
  }
  function appendChat (m) {
    const box = $('#chat')
    const empty = box.querySelector('.chat-empty'); if (empty) empty.remove()
    box.querySelectorAll('.yn').forEach(x => x.remove())
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80
    box.append(chatEl(m, true))
    if (near || m.role === 'user') box.scrollTop = box.scrollHeight
  }

  async function send (text) {
    try { await api('/command', { method: 'POST', body: { text } }) } catch (e) {
      appendChat({ role: 'bot', text: e.message, at: Date.now() })
    }
  }
  $('#cmdForm').addEventListener('submit', e => {
    e.preventDefault()
    const v = $('#cmdInput').value.trim()
    if (!v) return
    $('#cmdInput').value = ''
    send(v)
  })
  $$('#chips button').forEach(b => b.addEventListener('click', () => send(b.dataset.cmd)))
  $('#btnStop').addEventListener('click', () => send('stop'))

  // ---------- terminal ----------
  function logVisible (e) {
    if (ui.filter === 'chat') return e.level === 'chat'
    if (ui.filter === 'system') return e.level !== 'chat'
    return true
  }
  function logEl (e) {
    const p = document.createElement('p')
    p.className = `l-${e.level} s-${e.source}`
    const t = document.createElement('time'); t.textContent = new Date(e.at).toLocaleTimeString([], { hour12: false })
    p.append(t, document.createTextNode(e.text))
    return p
  }
  function renderLogs () {
    const box = $('#term'); box.innerHTML = ''
    const list = ui.logs.filter(logVisible)
    if (!list.length) { const p = document.createElement('p'); p.className = 'term-empty'; p.textContent = 'No log lines yet.'; box.append(p) }
    for (const e of list) box.append(logEl(e))
    box.scrollTop = box.scrollHeight
  }
  function appendLog (e) {
    if (!logVisible(e)) return
    const box = $('#term')
    const empty = box.querySelector('.term-empty'); if (empty) empty.remove()
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    box.append(logEl(e))
    while (box.childElementCount > 600) box.firstElementChild.remove()
    if (near) box.scrollTop = box.scrollHeight
  }
  $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
    ui.filter = b.dataset.filter
    $$('[data-filter]').forEach(x => x.setAttribute('aria-checked', String(x === b)))
    renderLogs()
  }))

  // ---------- tabs (phone) ----------
  function setTab (t) {
    document.body.dataset.tab = t
    $$('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)))
    if (t === 'terminal') { const box = $('#term'); box.scrollTop = box.scrollHeight }
    if (t === 'assistant') { const box = $('#chat'); box.scrollTop = box.scrollHeight }
  }
  $$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)))

  // ---------- auth dialog ----------
  function renderAuth () {
    const dlg = $('#authDlg')
    const a = ui.authPrompt
    if (!a) { if (dlg.open) dlg.close(); return }
    $('#authTitle').textContent = a.kind === 'register' ? 'Register the bot' : 'Log in the bot'
    $('#authText').textContent = a.kind === 'register'
      ? 'The server asks new players to /register. Choose a password for this bot account. It is sent only to the server and never shown in logs.'
      : 'The server asks for /login. Enter this bot account\'s password. It is sent only to the server and never shown in logs.'
    $('#authErr').textContent = a.error === 'wrong_password' ? 'The server said the last password was wrong.' : ''
    if (!dlg.open) { $('#authPw').value = ''; dlg.showModal(); setTimeout(() => $('#authPw').focus(), 50) }
  }
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault()
    const pw = $('#authPw').value
    if (!pw) { $('#authErr').textContent = 'Enter a password.'; return }
    try {
      await api('/auth', { method: 'POST', body: { password: pw, remember: $('#authRemember').checked } })
      $('#authPw').value = ''
      ui.authPrompt = null
      $('#authDlg').close()
    } catch (err) { $('#authErr').textContent = err.message }
  })
  $('#authCancel').addEventListener('click', async () => {
    $('#authPw').value = ''
    $('#authDlg').close()
    try { await api('/auth/dismiss', { method: 'POST' }) } catch {}
  })

  // ---------- microsoft ----------
  function showMsa (m) {
    if (!m) return
    $('#msaCode').textContent = m.code
    $('#msaLink').href = m.url
    $('#msaLink').textContent = m.url
    if (!$('#msaDlg').open) $('#msaDlg').showModal()
  }
  $('#msaClose').addEventListener('click', () => $('#msaDlg').close())

  // ---------- settings ----------
  $('#openSettings').addEventListener('click', async () => {
    $('#setErr').textContent = ''; $('#setOk').textContent = ''
    try { ui.settings = await api('/settings') } catch {}
    const s = ui.settings || {}
    $('#sOwner').value = s.ownerName || ''
    $('#sAutoReconnect').checked = !!s.autoReconnect
    $('#sAttempts').value = s.reconnectAttempts ?? 5
    $('#sAutoEat').checked = !!s.autoEat
    $('#sDig').checked = !!s.allowDiggingWhilePathing
    $('#sPlace').checked = !!s.allowBlockPlacingWhilePathing
    $('#sAi').checked = !!s.aiEnabled
    $('#sAiUrl').value = s.aiBaseUrl || ''
    $('#sAiModel').value = s.aiModel || ''
    $('#sAiKey').value = ''
    $('#sKeyState').textContent = s.aiKeySet ? '(saved — leave blank to keep)' : '(not set)'
    $('#setDlg').showModal()
  })
  $('#setClose').addEventListener('click', () => $('#setDlg').close())
  $('#setForm').addEventListener('submit', async e => {
    e.preventDefault()
    $('#setErr').textContent = ''; $('#setOk').textContent = ''
    const body = {
      ownerName: $('#sOwner').value.trim(),
      autoReconnect: $('#sAutoReconnect').checked,
      reconnectAttempts: Number($('#sAttempts').value || 0),
      autoEat: $('#sAutoEat').checked,
      allowDiggingWhilePathing: $('#sDig').checked,
      allowBlockPlacingWhilePathing: $('#sPlace').checked,
      aiEnabled: $('#sAi').checked,
      aiBaseUrl: $('#sAiUrl').value.trim(),
      aiModel: $('#sAiModel').value.trim()
    }
    const key = $('#sAiKey').value.trim()
    if (key) body.aiKey = key
    if (body.aiEnabled && !key && !(ui.settings && ui.settings.aiKeySet)) { $('#setErr').textContent = 'Add an API key to use the AI helper, or switch it off.'; return }
    try {
      ui.settings = await api('/settings', { method: 'PUT', body })
      $('#sAiKey').value = ''
      $('#sKeyState').textContent = ui.settings.aiKeySet ? '(saved — leave blank to keep)' : '(not set)'
      $('#setOk').textContent = 'Saved.'
    } catch (err) { $('#setErr').textContent = err.message }
  })
  $('#sForget').addEventListener('click', async () => {
    if (!confirm('Delete every server password saved on this device?')) return
    try { await api('/credentials/forget', { method: 'POST' }); $('#setOk').textContent = 'Saved passwords deleted.' } catch (e) { $('#setErr').textContent = e.message }
  })
  $('#sLogout').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }) } catch {}
    location.reload()
  })

  fillVersions()
  boot()
})()
