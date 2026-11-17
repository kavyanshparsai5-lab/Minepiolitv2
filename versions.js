'use strict'
// Version rules for MinePilot Java: Minecraft Java 1.18.1 and every newer version
// the installed Mineflayer / minecraft-data know about.
const mc = require('minecraft-protocol')
const minecraftData = require('minecraft-data')
const tcpDns = require('minecraft-protocol/src/client/tcp_dns')
const { testedVersions, latestSupportedVersion } = require('mineflayer/lib/version')

const MIN_VERSION = '1.18.1'
const MIN_PROTOCOL = 757 // 1.18 / 1.18.1 share protocol 757

function protocolOf (v) {
  const d = minecraftData(v)
  return d ? d.version.version : null
}
const MAX_PROTOCOL = protocolOf(latestSupportedVersion)

function latestSupported () { return latestSupportedVersion }

// The versions offered in the dashboard's manual picker (newest first).
function selectableVersions () {
  const out = testedVersions.filter(v => (protocolOf(v) || 0) >= MIN_PROTOCOL)
  if (!out.includes(MIN_VERSION) && minecraftData(MIN_VERSION)) out.unshift(MIN_VERSION)
  return out.reverse()
}

function rangeText () { return `${MIN_VERSION} to ${latestSupportedVersion}` }

// Manual pick: must be a version minecraft-data knows, inside the supported range.
function checkManual (v) {
  const d = minecraftData(v)
  if (!d || d.type !== 'pc') throw new Error(`Minecraft ${v} isn't a Java version MinePilot knows. Choose Auto-detect or a version from ${rangeText()}.`)
  const p = d.version.version
  if (p < MIN_PROTOCOL) throw new Error(`Minecraft ${v} is older than ${MIN_VERSION}. This MinePilot build supports Java ${rangeText()}.`)
  if (p > MAX_PROTOCOL) throw new Error(`Minecraft ${v} is newer than the newest version this install knows (${latestSupportedVersion}). Update MinePilot's Minecraft library (see README, "Newer Minecraft versions").`)
  return d.version.minecraftVersion
}

// Server protocol -> the Mineflayer version string to join with, or a clear error.
function resolveProtocol (protocol, versionName) {
  const name = versionName ? `${versionName} (protocol ${protocol})` : `protocol ${protocol}`
  if (typeof protocol !== 'number' || protocol < 0) throw new Error(`The server didn't report a usable Minecraft version (${name}).`)
  if (protocol < MIN_PROTOCOL) {
    throw new Error(`This server runs Minecraft ${name}, which is older than ${MIN_VERSION}. MinePilot Java supports ${rangeText()}.`)
  }
  if (protocol > MAX_PROTOCOL) {
    throw new Error(`This server runs Minecraft ${name}, newer than this MinePilot install supports (newest: ${latestSupportedVersion}). Update MinePilot's Minecraft library: npm install mineflayer@latest minecraft-data@latest minecraft-protocol@latest — see README, "Newer Minecraft versions".`)
  }
  const list = (minecraftData.postNettyVersionsByProtocolVersion.pc[protocol] || []).map(v => v.minecraftVersion)
  // prefer a release Mineflayer is tested on, then any release with data
  const pick = list.find(v => testedVersions.includes(v)) || list.find(v => /^\d+\.\d+(\.\d+)?$/.test(v) && minecraftData(v)) || list.find(v => minecraftData(v))
  if (!pick) throw new Error(`This server runs Minecraft ${name}. That exact build (maybe a snapshot or pre-release) isn't known to this MinePilot install. Supported: Java ${rangeText()} releases.`)
  return pick
}

// Status ping with an explicit handshake protocol number. A real Minecraft server
// answers with its own version whatever number we send; multi-version layers
// (ViaVersion, ViaBackwards, some proxies) echo back any number they can translate.
function rawPing ({ host, port, protocolVersion, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const client = new mc.Client(false, latestSupportedVersion)
    let done = false
    const finish = (err, data) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { client.end() } catch {}
      err ? reject(err) : resolve(data)
    }
    const timer = setTimeout(() => { const e = new Error('ping timeout'); e.code = 'ETIMEDOUT'; finish(e) }, timeoutMs)
    client.on('error', e => finish(e))
    client.on('end', () => finish(new Error('Connection closed before the server sent a status response')))
    client.once('server_info', packet => {
      let data
      try { data = JSON.parse(packet.response) } catch (e) { return finish(new Error('The server sent an unreadable status reply.')) }
      const start = Date.now()
      client.once('ping', () => { data.latency = Date.now() - start; finish(null, data) })
      setTimeout(() => finish(null, data), 3000)
      client.write('ping', { time: [0, 0] })
    })
    client.on('state', s => { if (s === mc.states.STATUS) client.write('ping_start', {}) })
    client.on('connect', () => {
      client.write('set_protocol', { protocolVersion, serverHost: host, serverPort: port, nextState: 1 })
      client.state = mc.states.STATUS
    })
    const opts = { host, port }
    tcpDns(client, opts)
    opts.connect(client)
  })
}

// Ping twice: once announcing the newest protocol we speak, once announcing a protocol
// no server or translator speaks (-1, the "just tell me your version" number).
// If the two answers differ, the server translates versions (ViaVersion or a proxy) and
// the second answer is its native version, which is what we join with.
async function detect ({ host, port }) {
  const latestProto = MAX_PROTOCOL
  const first = await rawPing({ host, port, protocolVersion: latestProto })
  if (!first || !first.version) throw new Error('The server answered but did not send a Java status reply. Is this a Bedrock server? This MinePilot build is Java-only.')
  let native = null
  let multiVersion = false
  if (first.version.protocol === latestProto) {
    try {
      const probe = await rawPing({ host, port, protocolVersion: -1, timeoutMs: 5000 })
      if (probe && probe.version && typeof probe.version.protocol === 'number' && probe.version.protocol !== first.version.protocol && probe.version.protocol > 0) {
        native = probe
        multiVersion = true
      }
    } catch { /* some servers drop the -1 probe; keep the first answer */ }
  }
  return { status: native || first, echoed: multiVersion ? first : null, multiVersion }
}

module.exports = { MIN_VERSION, MIN_PROTOCOL, MAX_PROTOCOL, latestSupported, selectableVersions, checkManual, resolveProtocol, detect, rawPing, rangeText }
