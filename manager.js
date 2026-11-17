'use strict'
const { EventEmitter } = require('events')
const { JavaDriver } = require('./drivers/java')
const { parse, COMMAND_HELP } = require('./commands')
const { redact } = require('./redact')
const ai = require('./ai')

const MAX_LOGS = 600
const MAX_CHAT = 200

class BotManager extends EventEmitter {
  constructor (store) {
    super()
    this.store = store
    this.driver = null
    this.conn = null
    this.state = 'idle'
    this.stateDetail = null
    this.logs = []
    this.chat = []
    this.authPrompt = null
    this.msa = null
    this.reconnect = { attempt: 0, timer: null, at: null }
    this.lastStatusJson = ''
  }

  // ----- outbound events -----
  pushLog (entry) {
    this.logs.push(entry)
    if (this.logs.length > MAX_LOGS) this.logs.shift()
    const tag = entry.level === 'error' ? 'ERR ' : entry.level === 'warn' ? 'WARN' : entry.level === 'chat' ? 'CHAT' : 'INFO'
    console.log(`[${new Date(entry.at).toISOString().slice(11, 19)}] ${tag} ${entry.text}`)
    this.emit('event', { type: 'log', entry })
  }

  sysLog (level, text) { this.pushLog({ level, source: 'system', text: redact(text), at: Date.now() }) }

  pushChat (role, text, extra = {}) {
    const entry = { role, text: redact(text), at: Date.now(), ...extra }
    this.chat.push(entry)
    if (this.chat.length > MAX_CHAT) this.chat.shift()
    this.emit('event', { type: 'chat', entry })
  }

  setState (state, detail = null) {
    this.state = state
    this.stateDetail = detail
    this.emit('event', { type: 'state', state, detail, reconnect: this.reconnectInfo() })
  }

  reconnectInfo () {
    return this.reconnect.timer ? { attempt: this.reconnect.attempt, max: this.store.settings.reconnectAttempts, at: this.reconnect.at } : null
  }

  status () {
    const base = this.driver ? this.driver.status() : { online: false }
    return {
      ...base,
      edition: this.conn ? this.conn.edition : null,
      capabilities: this.driver ? this.driver.capabilities() : null
    }
  }

  emitStatus () {
    const s = this.status()
    const j = JSON.stringify(s)
    if (j === this.lastStatusJson) return
    this.lastStatusJson = j
    this.emit('event', { type: 'status', status: s })
  }

  snapshot () {
    return {
      state: this.state,
      detail: this.stateDetail,
      reconnect: this.reconnectInfo(),
      connection: this.conn || this.store.config.lastConnection,
      status: this.status(),
      logs: this.logs.slice(-300),
      chat: this.chat.slice(-100),
      authPrompt: this.authPrompt,
      msa: this.msa,
      settings: this.store.publicSettings(),
      savedPassword: this.conn ? this.store.hasPassword(this.conn) : false
    }
  }

  // ----- connection control -----
  async connect (conn, { isRetry = false } = {}) {
    if (!isRetry) this.cancelReconnect()
    if (this.driver) await this.teardown()
    this.conn = conn
    this.store.setLastConnection(conn)
    this.authPrompt = null
    this.msa = null
    const ctx = { store: this.store, settings: () => this.store.settings }
    const driver = new JavaDriver(conn, ctx)
    this.driver = driver
    driver.on('log', e => this.pushLog(e))
    driver.on('reply', e => this.pushChat('bot', e.text, e.ask ? { ask: true } : {}))
    driver.on('state', ({ state, detail }) => {
      if (driver !== this.driver) return
      if (state === 'online') { this.reconnect.attempt = 0 }
      this.setState(state, detail)
      this.emitStatus()
    })
    driver.on('status', () => { if (driver === this.driver) this.emitStatus() })
    driver.on('auth', a => {
      if (driver !== this.driver) return
      this.authPrompt = a.state === 'needed' ? { kind: a.kind, error: a.error || null } : null
      this.emit('event', { type: 'auth', auth: this.authPrompt, state: a.state })
    })
    driver.on('msa', m => { this.msa = m; this.emit('event', { type: 'msa', msa: m }) })
    driver.on('ended', info => { if (driver === this.driver) this.onEnded(info) })
    this.setState('connecting')
    driver.connect().catch(e => {
      this.sysLog('error', `Unexpected connection error: ${e.message}`)
      this.setState('error', e.message)
    })
  }

  onEnded (info) {
    this.authPrompt = null
    this.msa = null
    this.emit('event', { type: 'auth', auth: null })
    this.emitStatus()
    const s = this.store.settings
    const inRetryChain = this.reconnect.attempt > 0
    if (info.stage === 'ping' && !inRetryChain) info = { ...info, retryable: false }
    if (info.retryable && s.autoReconnect && this.reconnect.attempt < s.reconnectAttempts) {
      this.reconnect.attempt++
      const delay = Math.min(60000, 5000 * Math.pow(2, this.reconnect.attempt - 1))
      this.reconnect.at = Date.now() + delay
      this.sysLog('info', `Auto-reconnect in ${Math.round(delay / 1000)} s (attempt ${this.reconnect.attempt}/${s.reconnectAttempts}).`)
      this.reconnect.timer = setTimeout(() => {
        this.reconnect.timer = null
        if (this.conn) this.connect(this.conn, { isRetry: true })
      }, delay)
      this.reconnect.pendingAttempt = true
      this.setState(this.state, this.stateDetail)
    } else if (info.retryable && s.autoReconnect) {
      this.sysLog('warn', `Gave up after ${s.reconnectAttempts} reconnect attempts. Press Reconnect to try again.`)
      this.reconnect.attempt = 0
    }
  }

  cancelReconnect () {
    if (this.reconnect.timer) clearTimeout(this.reconnect.timer)
    this.reconnect.timer = null
    this.reconnect.attempt = 0
  }

  async teardown () {
    const d = this.driver
    if (!d) return
    if (d.state === 'online' || d.state === 'connecting') {
      await new Promise(resolve => {
        const t = setTimeout(resolve, 3000)
        d.once('ended', () => { clearTimeout(t); resolve() })
        try { d.disconnect() } catch { clearTimeout(t); resolve() }
      })
    }
    d.removeAllListeners()
    if (this.driver === d) this.driver = null
  }

  async disconnect () {
    this.cancelReconnect()
    if (!this.driver) { this.setState('idle'); return false }
    const d = this.driver
    await new Promise(resolve => {
      const t = setTimeout(resolve, 3000)
      d.once('ended', () => { clearTimeout(t); resolve() })
      d.disconnect()
    })
    this.setState('offline')
    this.emitStatus()
    return true
  }

  async reconnectNow () {
    const conn = this.conn || this.store.config.lastConnection
    if (!conn) { const e = new Error('Nothing to reconnect to yet. Connect once first.'); e.status = 400; throw e }
    this.sysLog('info', 'Reconnecting…')
    await this.connect(conn)
  }

  // ----- auth -----
  submitAuth (password, remember) {
    const d = this.driver
    if (!d || d.state !== 'online') { const e = new Error('The bot is not connected.'); e.status = 409; throw e }
    if (!d.auth.kind) d.auth.kind = 'login'
    d.sendAuth(password, remember)
    this.authPrompt = null
    this.emit('event', { type: 'auth', auth: null, state: 'sent' })
  }

  dismissAuth () {
    this.authPrompt = null
    if (this.driver) this.driver.auth.state = 'dismissed'
    this.emit('event', { type: 'auth', auth: null })
  }

  // ----- commands -----
  async command (text) {
    this.pushChat('user', text)
    let cmd = parse(text)
    if (cmd.action === 'help') {
      const caps = this.driver ? this.driver.capabilities() : null
      const lines = COMMAND_HELP.map(([c, d]) => `${c} — ${d}`)
      let msg = 'Commands I understand:\n' + lines.join('\n')
      this.pushChat('bot', msg)
      return
    }
    if (cmd.action === 'unknown') {
      const s = this.store.settings
      if (s.aiEnabled && this.store.aiKey) {
        try {
          const out = await ai.translate(text, { baseUrl: s.aiBaseUrl, model: s.aiModel, apiKey: this.store.aiKey, context: s.ownerName ? `The user's in-game name is ${s.ownerName}.` : '' })
          const c2 = parse(out)
          if (c2.action === 'unknown' || c2.action === 'help') {
            this.pushChat('bot', "I couldn't turn that into a command I support. Type help for the list.")
            return
          }
          this.pushChat('bot', `AI read that as: "${out}"`)
          cmd = c2
        } catch (e) {
          this.pushChat('bot', `AI helper failed (${e.message}). Plain commands still work — type help.`)
          return
        }
      } else {
        this.pushChat('bot', "I didn't understand that. Type help for the list of commands" + (s.aiEnabled ? ' (the AI helper is on but has no API key).' : '.'))
        return
      }
    }
    if (!this.driver || this.driver.state !== 'online') {
      this.pushChat('bot', this.state === 'connecting' ? 'Still connecting — try again in a moment.' : 'The bot is not connected. Connect it to a server first.')
      return
    }
    if (cmd.action === 'yes' || cmd.action === 'no') {
      await this.driver.answer(cmd.action === 'yes')
      return
    }
    try {
      await this.driver.run(cmd)
    } catch (e) {
      this.pushChat('bot', `That failed: ${e.message}`)
    }
    this.emitStatus()
  }
}

module.exports = { BotManager }
