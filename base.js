'use strict'
const { EventEmitter } = require('events')
const { redact } = require('../redact')

class Cancelled extends Error { constructor () { super('Task cancelled'); this.cancelled = true } }

// Shared driver base (auth detection, confirmations, task bookkeeping). Every user-visible line goes out
// through log() / reply(), both of which redact secrets.
class BaseDriver extends EventEmitter {
  constructor (opts, ctx) {
    super()
    this.opts = opts // validated connection { edition, host, port, username, version, auth }
    this.ctx = ctx // { store, settings() }
    this.state = 'idle' // idle | connecting | online | offline | error
    this.task = null
    this.pending = null // { question, run, expires }
    this.auth = { state: 'none', kind: null, lastPromptAt: 0, sentAt: 0, password: null, remember: false }
    this.serverInfo = null
    this.closedByUser = false
    this.lastError = null
  }

  log (level, text, source = 'system') {
    this.emit('log', { level, source, text: redact(text), at: Date.now() })
  }

  reply (text, extra = {}) {
    this.emit('reply', { text: redact(text), at: Date.now(), ...extra })
  }

  setState (state, detail) {
    this.state = state
    this.emit('state', { state, detail: detail ? redact(detail) : null })
  }

  // --- confirmation flow ("ask before using extra resources") ---
  ask (question, run) {
    this.pending = { question, run, expires: Date.now() + 2 * 60 * 1000 }
    this.reply(question + ' (yes / no)', { ask: true })
    this.emit('status')
  }

  async answer (yes) {
    const p = this.pending
    this.pending = null
    this.emit('status')
    if (!p || p.expires < Date.now()) {
      this.reply("There's nothing waiting for a yes/no right now.")
      return
    }
    if (!yes) { this.reply("Okay, I won't do that.") ; return }
    await p.run()
  }

  // --- task bookkeeping ---
  beginTask (name) {
    if (this.task) this.cancelTask(true)
    const token = { name, cancelled: false, startedAt: Date.now() }
    this.task = token
    this.emit('status')
    return token
  }

  endTask (token) {
    if (this.task === token) { this.task = null; this.emit('status') }
  }

  check (token) { if (token.cancelled) throw new Cancelled() }

  cancelTask () {
    if (this.task) this.task.cancelled = true
    this.task = null
  }

  // --- authentication prompts (AuthMe, nLogin, LoginSecurity and similar) ---
  handleAuthText (text) {
    const t = text.replace(/§./g, '')
    const success = /(successful(ly)?\s*(log(ged)?\s*in|login|registered|authenticated|logged)|logged in successfully|registered successfully|login successful|you are now logged|you have (been )?(successfully )?(logged in|registered)|already logged in)/i
    const wrong = /(wrong|incorrect|invalid|bad)\s+password|password (is )?(wrong|incorrect)/i
    const notRegistered = /(isn'?t|is not|not) registered/i
    const wantsEmail = /\/(register|reg)\s+<\s*e-?mail/i
    const registerPrompt = /\/(register|reg)\b/i
    const loginPrompt = /\/(login|l|log)\b/i

    if (this.auth.state === 'sent' && success.test(t)) {
      this.auth.state = 'ok'
      this.reply('Logged in to the server ✔')
      this.log('info', 'Server confirmed the login.')
      if (this.auth.remember && this.auth.password) {
        this.ctx.store.rememberPassword(this.opts, this.auth.password)
        this.log('info', 'Password saved on this device for this server (Settings → Forget saved passwords to remove).')
      }
      this.auth.password = null
      this.emit('auth', { state: 'ok' })
      return
    }
    if (this.auth.state === 'sent' && wrong.test(t)) {
      const usedSaved = this.auth.fromSaved
      this.auth.state = 'needed'
      this.auth.password = null
      if (usedSaved) this.ctx.store.forgetPassword(this.opts)
      this.reply(usedSaved ? 'The saved password was rejected, so I removed it. Enter the right one.' : 'The server says the password is wrong. Try again.')
      this.emit('auth', { state: 'needed', kind: this.auth.kind, error: 'wrong_password' })
      return
    }
    if (this.auth.state === 'ok') return
    if (this.auth.state === 'sent' && notRegistered.test(t)) {
      this.auth.state = 'needed'
      this.auth.kind = 'register'
      this.reply('This account is not registered yet. Choose a password to register it.')
      this.emit('auth', { state: 'needed', kind: 'register' })
      return
    }
    let kind = null
    if (registerPrompt.test(t)) kind = 'register'
    else if (loginPrompt.test(t)) kind = 'login'
    if (!kind) return
    if (wantsEmail.test(t)) {
      this.reply('This server wants an e-mail address to register. Send it yourself with: say /register <email> <email>')
      return
    }
    const now = Date.now()
    if (this.auth.state === 'sent' && now - this.auth.sentAt < 6000) return // reminder echo right after we answered
    if (this.auth.state === 'needed' && this.auth.kind === kind && now - this.auth.lastPromptAt < 60000) return
    this.auth.kind = kind
    this.auth.confirm = /confirm|repeat|<password>\s*<password>|password>\s+<(confirm|re)/i.test(t) || kind === 'register'
    this.auth.lastPromptAt = now
    const saved = this.ctx.store.getPassword(this.opts)
    if (saved) {
      this.log('info', `Server asks for /${kind}. Using the password saved on this device.`)
      this.sendAuth(saved, false, true)
      return
    }
    this.auth.state = 'needed'
    this.reply(kind === 'register'
      ? 'The server wants me to /register. Choose a password for the bot in the box that just opened. It is never shown in logs.'
      : 'The server wants me to /login. Enter the bot account password in the box that just opened. It is never shown in logs.')
    this.emit('auth', { state: 'needed', kind })
  }

  sendAuth (password, remember, fromSaved = false) {
    require('../redact').remember(password)
    const kind = this.auth.kind || 'login'
    const cmd = kind === 'register' ? (this.auth.confirm === false ? `/register ${password}` : `/register ${password} ${password}`) : `/login ${password}`
    this.auth.state = 'sent'
    this.auth.sentAt = Date.now()
    this.auth.password = password
    this.auth.remember = !!remember
    this.auth.fromSaved = fromSaved
    this.sendRawChat(cmd)
    this.log('info', `Sent /${kind} ****** to the server.`)
    this.emit('auth', { state: 'sent', kind })
    // Some servers answer with a title instead of chat. If nothing came back,
    // say so instead of claiming success.
    setTimeout(() => {
      if (this.auth.state === 'sent' && Date.now() - this.auth.sentAt >= 9000) {
        this.reply(`I sent /${kind} but the server hasn't confirmed it in chat yet. If it keeps asking, the password may be wrong.`)
      }
    }, 9500)
  }
}

module.exports = { BaseDriver, Cancelled }
