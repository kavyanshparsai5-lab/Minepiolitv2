'use strict'
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const { WebSocketServer } = require('ws')
const { Store } = require('./store')
const { BotManager } = require('./manager')
const validate = require('./validate')
const { redact } = require('./redact')

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '127.0.0.1'
const ALLOW_LOCAL = (process.env.MINEPILOT_LOCAL_AUTOLOGIN || '1') !== '0'
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000

const store = new Store()
const ACCESS_KEY = process.env.MINEPILOT_ACCESS_KEY || store.config.accessKey
const manager = new BotManager(store)

// ---------- sessions ----------
const sessions = new Map() // id -> { created, seen, hits: [] }

function isLoopback (addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function parseCookies (header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function getSession (req) {
  const id = parseCookies(req.headers.cookie).mp_sid
  if (!id) return null
  const s = sessions.get(id)
  if (!s) return null
  if (Date.now() - s.seen > SESSION_IDLE_MS) { sessions.delete(id); return null }
  s.seen = Date.now()
  return s
}

function createSession (res) {
  const id = crypto.randomBytes(24).toString('base64url')
  sessions.set(id, { id, created: Date.now(), seen: Date.now(), hits: [] })
  res.setHeader('Set-Cookie', `mp_sid=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}`)
}

function keyMatches (k) {
  if (typeof k !== 'string') return false
  const a = Buffer.from(k); const b = Buffer.from(ACCESS_KEY)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- app ----------
const app = express()
app.disable('x-powered-by')
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  next()
})
app.use(express.json({ limit: '16kb' }))
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }))

const api = express.Router()

api.get('/session', (req, res) => {
  const s = getSession(req)
  res.json({ authenticated: !!s, localAutoLogin: ALLOW_LOCAL && isLoopback(req.socket.remoteAddress) })
})

const loginAttempts = new Map()
api.post('/session', (req, res) => {
  const ip = req.socket.remoteAddress
  const now = Date.now()
  const rec = (loginAttempts.get(ip) || []).filter(t => now - t < 60000)
  if (rec.length >= 10) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' })
  rec.push(now); loginAttempts.set(ip, rec)
  const local = ALLOW_LOCAL && isLoopback(ip)
  if (!local && !keyMatches(req.body && req.body.key)) return res.status(401).json({ error: 'Wrong access key.' })
  createSession(res)
  res.json({ ok: true })
})

// everything below needs a session; writes also need the custom header (CSRF guard)
api.use((req, res, next) => {
  const s = getSession(req)
  if (!s) return res.status(401).json({ error: 'Not signed in.' })
  if (req.method !== 'GET' && req.get('x-minepilot') !== '1') return res.status(403).json({ error: 'Missing request header.' })
  const now = Date.now()
  s.hits = s.hits.filter(t => now - t < 10000)
  if (s.hits.length > 40) return res.status(429).json({ error: 'Slow down — too many requests.' })
  s.hits.push(now)
  req.session = s
  next()
})

api.post('/logout', (req, res) => {
  sessions.delete(req.session.id)
  res.setHeader('Set-Cookie', 'mp_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  res.json({ ok: true })
})

api.get('/state', (req, res) => res.json(manager.snapshot()))

api.get('/versions', (req, res) => {
  const { selectableVersions, MIN_VERSION, latestSupported } = require('./versions')
  res.json({ java: selectableVersions(), min: MIN_VERSION, max: latestSupported() })
})

api.post('/connect', async (req, res, next) => {
  try {
    const conn = validate.connection(req.body)
    manager.connect(conn)
    res.json({ ok: true, connection: conn })
  } catch (e) { next(e) }
})

api.post('/disconnect', async (req, res, next) => {
  try { const had = await manager.disconnect(); res.json({ ok: true, wasConnected: had }) } catch (e) { next(e) }
})

api.post('/reconnect', async (req, res, next) => {
  try { await manager.reconnectNow(); res.json({ ok: true }) } catch (e) { next(e) }
})

api.post('/command', (req, res, next) => {
  try {
    const text = validate.command(req.body && req.body.text)
    manager.command(text).catch(e => manager.pushChat('bot', `That failed: ${e.message}`))
    res.json({ ok: true })
  } catch (e) { next(e) }
})

api.post('/auth', (req, res, next) => {
  try {
    const pw = validate.password(req.body && req.body.password)
    manager.submitAuth(pw, !!(req.body && req.body.remember))
    res.json({ ok: true })
  } catch (e) { next(e) }
})

api.post('/auth/dismiss', (req, res) => { manager.dismissAuth(); res.json({ ok: true }) })

api.get('/settings', (req, res) => res.json(store.publicSettings()))
api.put('/settings', (req, res, next) => {
  try {
    store.updateSettings(req.body || {})
    if (manager.driver && manager.driver.setupMovements && manager.driver.bot) manager.driver.setupMovements()
    const pub = store.publicSettings()
    manager.emit('event', { type: 'settings', settings: pub })
    res.json(pub)
  } catch (e) { next(e) }
})

api.post('/credentials/forget', (req, res) => {
  store.forgetAllPasswords()
  manager.sysLog('info', 'All saved server passwords were deleted from this device.')
  res.json({ ok: true })
})

app.use('/api', api)

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500)
  if (status >= 500) console.error(redact(err.stack || err.message))
  res.status(status).json({ error: status >= 500 ? 'Internal error: ' + redact(err.message) : redact(err.message), field: err.field || null })
})

// ---------- websocket ----------
const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/ws') return socket.destroy()
  const origin = req.headers.origin
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return socket.destroy() } catch { return socket.destroy() }
  }
  if (!getSession(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy() }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
wss.on('connection', ws => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  ws.on('message', () => {}) // the socket is read-only; commands go through the HTTP API
  ws.send(JSON.stringify({ type: 'snapshot', data: manager.snapshot() }))
})
manager.on('event', ev => {
  const msg = JSON.stringify(ev)
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg)
})
setInterval(() => {
  for (const c of wss.clients) {
    if (!c.isAlive) { c.terminate(); continue }
    c.isAlive = false
    try { c.ping() } catch {}
  }
}, 30000).unref()

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST
  console.log('')
  console.log('  MinePilot AI is running.')
  console.log(`  Open:  http://${shown}:${PORT}`)
  if (!isLoopback(HOST) && HOST !== 'localhost') {
    console.log(`  Access key for other devices: ${ACCESS_KEY}`)
    console.log('  (keep it private; anyone with it can control your bot)')
  }
  console.log(`  Data folder: ${store.dataDir}`)
  console.log('  Stop with Ctrl+C')
  console.log('')
})

function shutdown () {
  console.log('Shutting down…')
  manager.disconnect().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', e => console.error('Unhandled:', redact(e && e.stack || e)))
process.on('uncaughtException', e => console.error('Uncaught:', redact(e && e.stack || e)))
