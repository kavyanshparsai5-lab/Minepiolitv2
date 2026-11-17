'use strict'
const net = require('net')

const HOSTNAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/

function err (field, message) {
  const e = new Error(message)
  e.status = 400
  e.field = field
  return e
}

function host (v) {
  if (typeof v !== 'string') throw err('host', 'Server address is required.')
  let h = v.trim()
  if (!h) throw err('host', 'Server address is required.')
  // people paste "play.example.net:25565" into the address box; split it out
  let port = null
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(h)
  if (m && !net.isIPv6(h)) { h = m[1]; port = Number(m[2]) }
  if (/^https?:\/\//i.test(h)) throw err('host', 'Enter only the server address, without http://')
  if (!(net.isIP(h) || HOSTNAME.test(h))) throw err('host', 'That is not a valid server address. Use something like play.example.net or 192.168.1.20')
  return { host: h, port }
}

function port (v) {
  if (v === undefined || v === null || v === '') return 25565
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw err('port', 'Port must be a whole number between 1 and 65535.')
  return n
}

// This edition of MinePilot is Java-only. "java" (or nothing) is accepted for older saved configs.
function edition (v) {
  if (v === undefined || v === null || v === '' || v === 'java') return 'java'
  if (v === 'bedrock') throw err('edition', 'This MinePilot build supports Minecraft Java Edition only (1.18.1 and newer).')
  throw err('edition', 'Edition must be java.')
}

function username (v, ed, auth) {
  if (typeof v !== 'string' || !v.trim()) {
    if (auth === 'microsoft') return 'MinePilot' // the Microsoft account decides the real name
    throw err('username', 'Bot username is required.')
  }
  const u = v.trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) throw err('username', 'Java usernames are 3-16 characters: letters, numbers and _ only.')
  return u
}

function version (v) {
  if (v === undefined || v === null || v === '' || v === 'auto') return 'auto'
  if (typeof v !== 'string' || !/^\d{1,2}\.\d{1,3}(\.\d{1,3})?$/.test(v.trim())) throw err('version', 'Version must be "auto" or a number like 1.21.4')
  return v.trim()
}

function auth (v) {
  if (v === undefined || v === null || v === '') return 'offline'
  if (v !== 'offline' && v !== 'microsoft') throw err('auth', 'Account type must be offline or microsoft.')
  return v
}

function password (v) {
  if (typeof v !== 'string' || v.length < 1) throw err('password', 'Password is required.')
  if (v.length > 64) throw err('password', 'Password is too long (max 64).')
  if (/\s/.test(v)) throw err('password', 'Server passwords cannot contain spaces.')
  return v
}

function command (v) {
  if (typeof v !== 'string' || !v.trim()) throw err('text', 'Type a command.')
  if (v.length > 256) throw err('text', 'Commands are limited to 256 characters.')
  return v.trim()
}

function connection (body) {
  if (!body || typeof body !== 'object') throw err('body', 'Missing connection details.')
  const ed = edition(body.edition)
  const a = auth(body.auth)
  const h = host(body.host)
  const p = h.port != null && (body.port === undefined || body.port === '' || body.port === null) ? h.port : port(body.port)
  return {
    edition: ed,
    host: h.host,
    port: p,
    username: username(body.username, ed, a),
    version: version(body.version),
    auth: a
  }
}

module.exports = { connection, password, command, host, port, username, version, err }
