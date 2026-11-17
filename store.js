'use strict'
// Persistent configuration. Two files under DATA_DIR:
//   config.json  - last connection + settings (no secrets)
//   secrets.json - remembered server passwords and the optional AI key,
//                  written only when the user asks, file mode 600.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = process.env.MINEPILOT_DATA_DIR || path.join(__dirname, '..', 'data')

const DEFAULT_SETTINGS = {
  autoReconnect: true,
  reconnectAttempts: 5,
  autoEat: true,
  ownerName: '',
  allowBlockPlacingWhilePathing: false,
  allowDiggingWhilePathing: true,
  aiEnabled: false,
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini'
}

function ensureDir () {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')) } catch { return fallback }
}

function writeJson (file, data, mode = 0o600) {
  ensureDir()
  const p = path.join(DATA_DIR, file)
  const tmp = p + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode })
  fs.renameSync(tmp, p)
}

class Store {
  constructor () {
    ensureDir()
    const cfg = readJson('config.json', {})
    this.config = {
      lastConnection: cfg.lastConnection || null,
      settings: { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) },
      accessKey: cfg.accessKey || crypto.randomBytes(18).toString('base64url')
    }
    this.secrets = readJson('secrets.json', { credentials: {}, aiKey: '' })
    if (!this.secrets.credentials) this.secrets.credentials = {}
    this.saveConfig()
  }

  get dataDir () { return DATA_DIR }

  saveConfig () { writeJson('config.json', this.config) }
  saveSecrets () { writeJson('secrets.json', this.secrets) }

  get settings () { return this.config.settings }

  updateSettings (patch) {
    const s = this.config.settings
    const out = { ...s }
    const bool = k => { if (k in patch) { if (typeof patch[k] !== 'boolean') throw bad(k, 'must be true or false'); out[k] = patch[k] } }
    ;['autoReconnect', 'autoEat', 'allowBlockPlacingWhilePathing', 'allowDiggingWhilePathing', 'aiEnabled'].forEach(bool)
    if ('reconnectAttempts' in patch) {
      const n = Number(patch.reconnectAttempts)
      if (!Number.isInteger(n) || n < 0 || n > 20) throw bad('reconnectAttempts', 'must be 0-20')
      out.reconnectAttempts = n
    }
    if ('ownerName' in patch) {
      const v = String(patch.ownerName || '').trim()
      if (v && !/^[A-Za-z0-9_ ]{1,16}$/.test(v)) throw bad('ownerName', 'must be a Minecraft name (letters, numbers, _)')
      out.ownerName = v
    }
    if ('aiBaseUrl' in patch) {
      const v = String(patch.aiBaseUrl || '').trim().replace(/\/+$/, '')
      if (v) {
        let u
        try { u = new URL(v) } catch { throw bad('aiBaseUrl', 'must be a URL like https://api.openai.com/v1') }
        if (!/^https?:$/.test(u.protocol)) throw bad('aiBaseUrl', 'must start with https:// or http://')
      }
      out.aiBaseUrl = v || DEFAULT_SETTINGS.aiBaseUrl
    }
    if ('aiModel' in patch) {
      const v = String(patch.aiModel || '').trim()
      if (v.length > 80 || !/^[\w.:/\-]*$/.test(v)) throw bad('aiModel', 'is not a valid model name')
      out.aiModel = v || DEFAULT_SETTINGS.aiModel
    }
    if ('aiKey' in patch) {
      const v = String(patch.aiKey || '').trim()
      if (v.length > 300) throw bad('aiKey', 'is too long')
      this.secrets.aiKey = v
      this.saveSecrets()
    }
    this.config.settings = out
    this.saveConfig()
    return out
  }

  publicSettings () {
    return { ...this.config.settings, aiKeySet: !!this.secrets.aiKey }
  }

  setLastConnection (c) {
    this.config.lastConnection = { edition: c.edition, host: c.host, port: c.port, username: c.username, version: c.version, auth: c.auth }
    this.saveConfig()
  }

  credKey (c) { return `${c.edition}:${c.host.toLowerCase()}:${c.port}:${c.username.toLowerCase()}` }

  getPassword (c) { return this.secrets.credentials[this.credKey(c)] || null }

  rememberPassword (c, pw) {
    this.secrets.credentials[this.credKey(c)] = pw
    this.saveSecrets()
  }

  forgetPassword (c) {
    delete this.secrets.credentials[this.credKey(c)]
    this.saveSecrets()
  }

  hasPassword (c) { return !!this.secrets.credentials[this.credKey(c)] }

  forgetAllPasswords () {
    this.secrets.credentials = {}
    this.saveSecrets()
  }

  get aiKey () { return this.secrets.aiKey || '' }
}

function bad (field, msg) {
  const e = new Error(`${field} ${msg}`)
  e.status = 400
  e.field = field
  return e
}

module.exports = { Store, DEFAULT_SETTINGS }
