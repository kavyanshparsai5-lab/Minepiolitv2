'use strict'
const path = require('path')
const mineflayer = require('mineflayer')
const minecraftData = require('minecraft-data')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock')
const { Vec3 } = require('vec3')
const { BaseDriver, Cancelled } = require('./base')
const { registryCandidates } = require('../commands')
const versions = require('../versions')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// "stick", 4 -> "sticks"; "oak_planks", 4 -> "oak planks"
function nice (name, n) {
  const s = name.replace(/_/g, ' ')
  if (n === 1 || /s$|glass$|wool$|dirt$|stone$|cobblestone$|sand$|gravel$/.test(s)) return s
  return s + 's'
}

const FRIENDLY_ALIASES = {
  wood: 'log', woods: 'log', logs: 'log', tree: 'log', trees: 'log',
  plank: 'planks', 'wooden planks': 'planks', 'wood planks': 'planks',
  workbench: 'crafting_table', 'crafting bench': 'crafting_table', table: 'crafting_table',
  'wood pickaxe': 'wooden_pickaxe', 'wood axe': 'wooden_axe', 'wood sword': 'wooden_sword', 'wood shovel': 'wooden_shovel', 'wood hoe': 'wooden_hoe',
  'stone pick': 'stone_pickaxe', 'wooden pick': 'wooden_pickaxe', 'iron pick': 'iron_pickaxe',
  iron: 'iron_ore', coal: 'coal_ore', diamond: 'diamond_ore', diamonds: 'diamond_ore', gold: 'gold_ore', copper: 'copper_ore', redstone: 'redstone_ore', emerald: 'emerald_ore', lapis: 'lapis_ore',
  cobble: 'cobblestone', torches: 'torch', sticks: 'stick', furnaces: 'furnace', chests: 'chest'
}

function friendlyError (e) {
  const code = e && (e.code || (e.cause && e.cause.code))
  const msg = (e && e.message) || String(e)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Server address not found. Check the IP / domain spelling.'
  if (code === 'ECONNREFUSED') return 'Connection refused. The server is offline or the port is wrong.'
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return 'The server did not answer in time. It may be offline, firewalled, or the port is wrong.'
  if (code === 'ECONNRESET') return 'The server closed the connection.'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'The server address is unreachable from this device.'
  return msg
}

function chatToText (reason, registry) {
  if (reason == null) return ''
  try {
    const ChatMessage = require('prismarine-chat')(registry || '1.21.4')
    if (typeof reason === 'string') {
      try { return new ChatMessage(JSON.parse(reason)).toString() } catch { return reason }
    }
    if (reason.type && reason.value) return ChatMessage.fromNotch(reason).toString() // NBT
    return new ChatMessage(reason).toString()
  } catch {
    return typeof reason === 'string' ? reason : JSON.stringify(reason)
  }
}

class JavaDriver extends BaseDriver {
  constructor (opts, ctx) {
    super(opts, ctx)
    this.bot = null
    this.mcData = null
    this.version = null
    this.spawned = false
    this.eating = false
  }

  capabilities () {
    return { move: true, follow: true, chat: true, inventory: true, mine: true, craft: true, survival: true }
  }

  // ---------- connection ----------
  async pingServer () {
    const { host, port } = this.opts
    this.log('info', `Checking ${host}:${port}…`)
    const det = await versions.detect({ host, port })
    const res = det.status
    const motd = chatToText(res.description).replace(/§./g, '').replace(/\s+/g, ' ').trim()
    this.serverInfo = {
      versionName: res.version.name,
      protocol: res.version.protocol,
      multiVersion: det.multiVersion,
      playersOnline: res.players ? res.players.online : null,
      playersMax: res.players ? res.players.max : null,
      motd,
      latencyMs: res.latency ?? null
    }
    this.log('info', `Server found: ${res.version.name} (protocol ${res.version.protocol}), ${this.serverInfo.playersOnline}/${this.serverInfo.playersMax} players${motd ? ' — "' + motd + '"' : ''}`)
    if (det.multiVersion) {
      this.log('info', `This server accepts several Minecraft versions (ViaVersion or a proxy). It also offered protocol ${det.echoed.version.protocol}; MinePilot joins at the server's own version instead, so blocks, items and recipes match the server.`)
    }
    return res
  }

  resolveVersion (protocol) {
    if (this.opts.version !== 'auto') {
      const v = versions.checkManual(this.opts.version)
      if (this.serverInfo && !this.serverInfo.multiVersion && this.serverInfo.protocol !== minecraftData(v).version.version) {
        this.log('warn', `You picked ${v}, but the server reports ${this.serverInfo.versionName}. If joining fails, switch Version back to Auto-detect.`)
      }
      return v
    }
    return versions.resolveProtocol(protocol, this.serverInfo && this.serverInfo.versionName)
  }

  async connect () {
    this.closedByUser = false
    this.setState('connecting')
    let pingRes
    try {
      pingRes = await this.pingServer()
      this.version = this.resolveVersion(pingRes.version.protocol)
      if (this.opts.version === 'auto') this.log('info', `Using protocol for Minecraft ${this.version} (auto-detected).`)
    } catch (e) {
      let msg = friendlyError(e)
      if ((this.opts.port === 19132 || this.opts.port === 19133) && !/older than|newer than/.test(msg)) msg += ' Port 19132 is the usual Bedrock Edition port — this MinePilot build is Java-only (Java servers usually use 25565).'
      this.lastError = msg
      this.log('error', msg)
      this.setState('error', msg)
      this.emit('ended', { reason: msg, retryable: /did not answer|closed the connection|refused/i.test(msg), stage: 'ping' })
      return
    }
    if (this.closedByUser) return

    const { host, port, username, auth } = this.opts
    const options = {
      host,
      port,
      username,
      version: this.version,
      auth: auth === 'microsoft' ? 'microsoft' : 'offline',
      hideErrors: true,
      logErrors: false,
      checkTimeoutInterval: 30 * 1000,
      profilesFolder: path.join(this.ctx.store.dataDir, 'microsoft-auth'),
      onMsaCode: data => {
        this.reply(`Microsoft sign-in: open ${data.verification_uri} and enter code ${data.user_code}`, { msa: { url: data.verification_uri, code: data.user_code } })
        this.log('info', `Waiting for Microsoft sign-in (code ${data.user_code}).`)
        this.emit('msa', { url: data.verification_uri, code: data.user_code, expiresIn: data.expires_in })
      }
    }
    this.log('info', `Joining as ${username} (${auth === 'microsoft' ? 'Microsoft account' : 'offline / cracked mode'})…`)
    let bot
    try {
      bot = mineflayer.createBot(options)
    } catch (e) {
      const msg = friendlyError(e)
      this.log('error', msg)
      this.setState('error', msg)
      this.emit('ended', { reason: msg, retryable: false })
      return
    }
    this.bot = bot
    bot.loadPlugin(pathfinder)
    bot.loadPlugin(collectBlock.plugin)

    const spawnTimeoutMs = auth === 'microsoft' ? 5 * 60 * 1000 : 45 * 1000
    this.spawnTimer = setTimeout(() => {
      if (!this.spawned) {
        this.log('error', `No spawn after ${Math.round(spawnTimeoutMs / 1000)} s — giving up.`)
        this.lastError = 'Timed out while joining the server.'
        this.endBot('Timed out while joining the server.')
      }
    }, spawnTimeoutMs)

    bot.once('login', () => {
      this.log('info', `Logged in to the server as ${bot.username}.`)
    })

    bot.once('spawn', () => {
      clearTimeout(this.spawnTimer)
      this.spawned = true
      this.mcData = minecraftData(bot.version)
      this.setupMovements()
      this.setState('online')
      const p = bot.entity.position
      this.log('info', `Spawned at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} in ${bot.game.dimension} (${bot.game.gameMode}).`)
      this.reply(`Connected to ${host} as ${bot.username}. Type "help" to see what I can do.`)
      this.emit('status')
      this.statusTimer = setInterval(() => this.emit('status'), 1000)
    })

    bot.on('messagestr', (message, position) => {
      if (!message || !message.trim()) return
      if (position === 'game_info') { // action bar
        if (/\/(login|register|l|reg)\b/i.test(message)) this.handleAuthText(message)
        return
      }
      this.log('chat', message, 'server')
      this.handleAuthText(message)
    })

    bot.on('title', (text) => {
      const t = chatToText(text, bot.registry)
      if (t && /\/(login|register)\b|password/i.test(t)) { this.log('chat', `[title] ${t}`, 'server'); this.handleAuthText(t) }
    })

    bot.on('kicked', (reason, loggedIn) => {
      const text = chatToText(reason, bot.registry).replace(/§./g, '').trim() || 'no reason given'
      this.lastError = `Kicked: ${text}`
      this.kickedText = text
      this.log('error', `Kicked by the server: ${text}`)
      if (/(wrong|incorrect|invalid) password/i.test(text)) {
        if (this.auth.fromSaved) this.ctx.store.forgetPassword(this.opts)
        this.reply(`The server kicked me for a wrong password${this.auth.fromSaved ? ' (I deleted the saved one)' : ''}. Press Connect and enter the right password when it asks.`)
      }
    })

    bot.on('error', e => {
      const msg = friendlyError(e)
      this.lastError = msg
      this.log('error', msg)
    })

    bot.on('death', () => {
      this.log('warn', 'The bot died. Respawning…')
      if (this.task) { this.cancelTask(); this.reply('I died, so I stopped the current task. Respawning now.') }
    })

    bot.on('respawn', () => this.emit('status'))

    bot.on('health', () => this.maybeAutoEat())

    bot.on('playerJoined', () => this.emit('status'))
    bot.on('playerLeft', () => this.emit('status'))

    bot.on('end', reason => {
      clearTimeout(this.spawnTimer)
      clearInterval(this.statusTimer)
      const wasOnline = this.spawned
      this.spawned = false
      this.cancelTask()
      const why = this.kickedText ? `Kicked: ${this.kickedText}` : (this.lastError || reason || 'connection closed')
      this.log(this.closedByUser ? 'info' : 'warn', this.closedByUser ? 'Disconnected.' : `Disconnected: ${why}`)
      this.setState(this.closedByUser ? 'offline' : 'error', this.closedByUser ? null : why)
      const kickedForGood = this.kickedText && /(password|banned|whitelist|white-listed|not whitelisted|logged in from another location|duplicate|already (online|playing|connected)|outdated|unsupported|name.*(taken|invalid))/i.test(this.kickedText)
      this.emit('ended', { reason: why, retryable: !this.closedByUser && wasOnline && !kickedForGood, wasOnline })
      this.bot = null
    })
  }

  setupMovements () {
    const bot = this.bot
    const s = this.ctx.settings()
    const m = new Movements(bot)
    m.canDig = !!s.allowDiggingWhilePathing
    m.allow1by1towers = !!s.allowBlockPlacingWhilePathing
    if (!s.allowBlockPlacingWhilePathing) m.scafoldingBlocks = []
    m.allowParkour = true
    m.allowSprinting = true
    this.movements = m
    bot.pathfinder.setMovements(m)
    bot.pathfinder.thinkTimeout = 6000
  }

  endBot (reason) {
    if (this.bot) {
      try { this.bot.quit(reason) } catch {}
      try { this.bot.end(reason) } catch {}
    }
  }

  disconnect () {
    this.closedByUser = true
    this.cancelTask()
    if (this.bot) this.endBot('disconnect.quitting')
    else { this.setState('offline'); this.emit('ended', { reason: 'stopped by user', retryable: false }) }
  }

  sendRawChat (text) {
    if (!this.bot || !this.spawned) throw new Error('Not connected')
    this.bot.chat(text)
  }

  // ---------- status ----------
  status () {
    const bot = this.bot
    if (!bot || !this.spawned || !bot.entity) return { online: false, serverInfo: this.serverInfo, version: this.version }
    const p = bot.entity.position
    return {
      online: true,
      username: bot.username,
      version: bot.version,
      serverInfo: this.serverInfo,
      health: Math.round(bot.health * 10) / 10,
      food: bot.food,
      saturation: Math.round((bot.foodSaturation || 0) * 10) / 10,
      position: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
      dimension: bot.game.dimension,
      gameMode: bot.game.gameMode,
      timeOfDay: bot.time ? bot.time.timeOfDay : null,
      isDay: bot.time ? bot.time.isDay : null,
      ping: bot.player ? bot.player.ping : null,
      held: bot.heldItem ? bot.heldItem.name : null,
      players: Object.keys(bot.players).filter(n => n !== bot.username),
      task: this.task ? this.task.name : null,
      pending: this.pending ? this.pending.question : null,
      inventory: this.inventoryList(),
      authState: this.auth.state
    }
  }

  inventoryList () {
    if (!this.bot) return []
    const map = new Map()
    for (const it of this.bot.inventory.items()) {
      const k = it.name
      const cur = map.get(k) || { name: k, displayName: it.displayName, count: 0 }
      cur.count += it.count
      map.set(k, cur)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }

  invMap () {
    const m = new Map()
    for (const it of this.inventoryList()) m.set(it.name, it.count)
    return m
  }

  count (pred) {
    let n = 0
    for (const it of this.bot.inventory.items()) if (pred(it.name)) n += it.count
    return n
  }

  diffInventory (before) {
    const after = this.invMap()
    const gained = []
    for (const [k, v] of after) { const d = v - (before.get(k) || 0); if (d > 0) gained.push([k, d]) }
    return gained
  }

  fmtItems (pairs) {
    return pairs.map(([n, c]) => `${c} × ${n.replace(/_/g, ' ')}`).join(', ')
  }

  // ---------- command dispatch ----------
  async run (cmd) {
    if (!this.bot || !this.spawned) { this.reply('The bot is not in the game yet.') ; return }
    switch (cmd.action) {
      case 'stop': return this.stop()
      case 'say': return this.say(cmd.message)
      case 'inventory': return this.cmdInventory()
      case 'status': return this.cmdStatus()
      case 'players': return this.cmdPlayers()
      case 'jump': return this.cmdJump()
      case 'follow': return this.cmdFollow(cmd.player)
      case 'come': return this.cmdCome(cmd.player)
      case 'goto': return this.cmdGoto(cmd)
      case 'explore': return this.cmdExplore(cmd.radius)
      case 'collect': return this.cmdMine('log', cmd.count, true)
      case 'mine': return this.cmdMine(cmd.block, cmd.count, false)
      case 'craft': return this.cmdCraft(cmd.item, cmd.count)
      case 'equip': return this.cmdEquip(cmd.item)
      case 'drop': return this.cmdDrop(cmd.item, cmd.count)
      case 'eat': return this.cmdEat(false)
      case 'sleep': return this.cmdSleep()
      default: this.reply("I didn't understand that. Type help for the list.")
    }
  }

  stop () {
    const had = this.task ? this.task.name : null
    this.cancelTask()
    const bot = this.bot
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.collectBlock.cancelTask() } catch {}
    try { bot.stopDigging() } catch {}
    try { bot.clearControlStates() } catch {}
    if (this.pending) this.pending = null
    this.reply(had ? `Stopping current task (${had}).` : 'Stopped. Nothing was running.')
    this.emit('status')
  }

  say (message) {
    const text = String(message).slice(0, 256)
    try {
      this.sendRawChat(text)
      if (/^\/(login|l|register|reg)\b/i.test(text)) {
        // user typed the auth command by hand: treat it like the password box
        const pw = text.split(/\s+/)[1]
        if (pw) require('../redact').remember(pw)
        this.auth.state = 'sent'; this.auth.sentAt = Date.now(); this.auth.kind = /^\/(register|reg)/i.test(text) ? 'register' : 'login'
      }
      if (text.startsWith('/')) this.log('chat', `${this.bot.username} ran ${text}`, 'bot')
      this.reply(text.startsWith('/') ? `Sent command ${text}` : `Said: ${text}`)
    } catch (e) {
      this.reply(`Couldn't send that: ${e.message}`)
    }
  }

  cmdInventory () {
    const inv = this.inventoryList()
    if (!inv.length) { this.reply('Checked my inventory: it is empty.') ; return }
    const used = this.bot.inventory.items().length
    this.reply(`Inventory (${used}/36 slots used): ${this.fmtItems(inv.map(i => [i.name, i.count]))}${this.bot.heldItem ? `. Holding ${this.bot.heldItem.name.replace(/_/g, ' ')}.` : '.'}`)
  }

  cmdStatus () {
    const s = this.status()
    this.reply(`Health ${s.health}/20, food ${s.food}/20, at ${s.position.x}, ${s.position.y}, ${s.position.z} in ${s.dimension} (${s.gameMode}). ${s.task ? 'Doing: ' + s.task + '.' : 'Idle.'}`)
  }

  cmdPlayers () {
    const names = Object.keys(this.bot.players).filter(n => n !== this.bot.username)
    this.reply(names.length ? `Online (${names.length}): ${names.join(', ')}` : "I'm the only one online.")
  }

  async cmdJump () {
    const bot = this.bot
    if (!bot.entity.onGround) { this.reply("I'm not standing on the ground right now, so I can't jump.") ; return }
    const y0 = bot.entity.position.y
    let peak = y0
    bot.setControlState('jump', true)
    const t0 = Date.now()
    while (Date.now() - t0 < 500) { await sleep(50); peak = Math.max(peak, bot.entity.position.y) }
    bot.setControlState('jump', false)
    this.reply(peak - y0 > 0.3 ? `Jumped (${(peak - y0).toFixed(1)} blocks up).` : 'I tried to jump but something above me blocked it.')
  }

  findPlayer (name) {
    const bot = this.bot
    let wanted = name
    if (!wanted || wanted === 'me' || wanted === 'myself') {
      wanted = this.ctx.settings().ownerName
      if (!wanted) return { error: 'Who is "me"? Set your in-game name in Settings, or say e.g. "follow Steve".' }
    }
    const key = Object.keys(bot.players).find(n => n.toLowerCase() === wanted.toLowerCase())
    if (!key) {
      const others = Object.keys(bot.players).filter(n => n !== bot.username)
      return { error: `${wanted} isn't online on this server.${others.length ? ' Online: ' + others.join(', ') + '.' : ''}` }
    }
    if (key === bot.username) return { error: "That's me." }
    const p = bot.players[key]
    if (!p.entity) return { error: `${key} is online but too far away for me to see (outside my render distance). Ask them to come closer, or send me their coordinates with goto x y z.` }
    return { name: key, entity: p.entity }
  }

  async cmdFollow (name) {
    const r = this.findPlayer(name)
    if (r.error) { this.reply(r.error) ; return }
    const token = this.beginTask(`following ${r.name}`)
    this.reply(`Following ${r.name}.`)
    const bot = this.bot
    bot.pathfinder.setGoal(new goals.GoalFollow(r.entity, 2), true)
    const onGone = (e) => {
      if (e === r.entity && this.task === token) {
        this.reply(`I lost sight of ${r.name}, so I stopped following.`)
        bot.pathfinder.setGoal(null)
        this.endTask(token)
      }
    }
    bot.on('entityGone', onGone)
    while (!token.cancelled && this.bot === bot) await sleep(500)
    bot.removeListener('entityGone', onGone)
  }

  async gotoGoal (goal, token, timeoutMs) {
    const bot = this.bot
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => { try { bot.pathfinder.setGoal(null) } catch {} ; reject(new Error('took too long')) }, timeoutMs)
    })
    let done = false
    ;(async () => {
      while (!done && !token.cancelled) await sleep(200)
      if (!done) { try { bot.pathfinder.setGoal(null) } catch {} }
    })()
    try {
      await Promise.race([bot.pathfinder.goto(goal), timeout])
    } catch (e) {
      if (token.cancelled) throw new Cancelled()
      throw new Error(/noPath|No path/i.test(e.name + e.message) ? 'no path' : (e.message || 'path failed'))
    } finally {
      done = true
      clearTimeout(timer)
    }
  }

  async cmdCome (name) {
    const r = this.findPlayer(name)
    if (r.error) { this.reply(r.error) ; return }
    const token = this.beginTask(`walking to ${r.name}`)
    this.reply(`Coming to ${r.name}.`)
    const p = r.entity.position
    try {
      await this.gotoGoal(new goals.GoalNear(p.x, p.y, p.z, 2), token, 90000)
      this.reply(`I'm next to ${r.name} now.`)
    } catch (e) {
      if (!e.cancelled) this.reply(`I couldn't reach ${r.name}: ${e.message}.`)
    } finally { this.endTask(token) }
  }

  async cmdGoto ({ x, y, z }) {
    const bot = this.bot
    if (Math.abs(x) > 29999984 || Math.abs(z) > 29999984 || (y !== undefined && (y < -64 || y > 320))) { this.reply('Those coordinates are outside the world.') ; return }
    const here = bot.entity.position
    const dist = Math.hypot(x - here.x, z - here.z)
    const go = async () => {
      const token = this.beginTask(`going to ${x}, ${y ?? '~'}, ${z}`)
      this.reply(`Walking to ${x}, ${y ?? '(any height)'}, ${z} — about ${Math.round(dist)} blocks.`)
      try {
        const goal = y === undefined ? new goals.GoalNearXZ(x, z, 1) : new goals.GoalNear(x, y, z, 1)
        await this.gotoGoal(goal, token, Math.max(60000, dist * 1500))
        const p = bot.entity.position
        this.reply(`Arrived at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}.`)
      } catch (e) {
        if (!e.cancelled) {
          const p = bot.entity.position
          const hint = this.ctx.settings().allowBlockPlacingWhilePathing ? '' : ' If I\'m stuck in a hole, turn on Settings → "Allow placing blocks to climb" so I can build my way up.'
          this.reply(`I couldn't get there (${e.message}). I'm at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}.${hint}`)
        }
      } finally { this.endTask(token) }
    }
    if (dist > 1000) this.ask(`That's ${Math.round(dist)} blocks away — a long walk through unloaded chunks. Go anyway?`, go)
    else await go()
  }

  async cmdExplore (radius) {
    const bot = this.bot
    const token = this.beginTask(`exploring (${radius} blocks)`)
    const c = bot.entity.position.clone()
    this.reply(`Exploring within ${radius} blocks of ${c.x.toFixed(0)}, ${c.z.toFixed(0)}. Say stop to end.`)
    let legs = 0; let fails = 0
    try {
      while (!token.cancelled && fails < 6) {
        const a = Math.random() * Math.PI * 2
        const d = radius * (0.35 + Math.random() * 0.65)
        const tx = Math.round(c.x + Math.cos(a) * d); const tz = Math.round(c.z + Math.sin(a) * d)
        try {
          await this.gotoGoal(new goals.GoalNearXZ(tx, tz, 3), token, 30000)
          legs++; fails = 0
          this.log('info', `Explore: reached ${tx}, ${tz}.`)
          if (Math.random() < 0.3) { bot.setControlState('jump', true); await sleep(300); bot.setControlState('jump', false) }
          await sleep(500)
        } catch (e) {
          if (e.cancelled) throw e
          fails++
          this.log('warn', `Explore: couldn't reach ${tx}, ${tz} (${e.message}), trying another spot.`)
        }
      }
      if (fails >= 6) this.reply(`I stopped exploring: 6 spots in a row were unreachable (water, cliffs or walls). Visited ${legs} spots.`)
    } catch (e) {
      if (!e.cancelled) this.reply(`Exploring stopped: ${e.message}`)
    } finally { this.endTask(token) }
  }

  // ---------- registry helpers ----------
  resolveBlockNames (phrase) {
    const data = this.mcData
    let p = phrase.toLowerCase().trim()
    if (FRIENDLY_ALIASES[p]) p = FRIENDLY_ALIASES[p]
    const cands = registryCandidates(p)
    for (const c of cands) {
      if (c === 'log' || c === 'logs') return Object.keys(data.blocksByName).filter(n => /_log$/.test(n) || /_stem$/.test(n) && !/stripped|mushroom/.test(n)).filter(n => !/stripped/.test(n))
      if (data.blocksByName[c]) {
        const names = [c]
        if (/_ore$/.test(c) && data.blocksByName['deepslate_' + c]) names.push('deepslate_' + c)
        return names
      }
    }
    for (const c of cands) {
      const suffix = Object.keys(data.blocksByName).filter(n => n.endsWith('_' + c))
      if (suffix.length) return suffix
    }
    return []
  }

  resolveItemName (phrase) {
    const data = this.mcData
    let p = phrase.toLowerCase().trim()
    if (FRIENDLY_ALIASES[p]) p = FRIENDLY_ALIASES[p]
    const cands = registryCandidates(p)
    if (p.replace(/\s+/g, '_') === 'planks' || p === 'planks') cands.unshift('planks')
    for (const c of cands) if (data.itemsByName[c]) return { name: c }
    for (const c of cands) {
      const family = Object.keys(data.itemsByName).filter(n => n.endsWith('_' + c))
      if (family.length) return { family }
    }
    return null
  }

  // pick a member of an item family (e.g. *_planks) that fits what we carry
  pickFromFamily (family) {
    const inv = this.invMap()
    // prefer a member we can craft right now from what we carry (e.g. birch planks from birch logs)
    const table = this.findTable(4)
    const craftable = family.filter(n => this.mcData.itemsByName[n] && this.bot.recipesFor(this.mcData.itemsByName[n].id, null, 1, table).length)
    // score = how many of that member we hold or can make from logs we carry
    // (e.g. 6 dark oak logs beat 2 oak logs for "planks")
    const score = n => {
      let s = inv.get(n) || 0
      const wood = n.replace(/_planks$/, '')
      if (wood !== n) for (const l of [`${wood}_log`, `${wood}_wood`, `${wood}_stem`, `${wood}_hyphae`, `${wood}_block`]) s += 4 * (inv.get(l) || 0)
      return s
    }
    if (craftable.length) return craftable.sort((a, b) => score(b) - score(a))[0]
    const have = family.filter(n => inv.get(n) > 0).sort((a, b) => inv.get(b) - inv.get(a))
    if (have.length) return have[0]
    // planks: choose the plank type whose log we carry
    for (const n of family) {
      const wood = n.replace(/_planks$/, '')
      if (wood !== n && ([`${wood}_log`, `${wood}_stem`].some(l => inv.get(l) > 0))) return n
    }
    return family.find(n => n.startsWith('oak_')) || family[0]
  }

  hasHarvestTool (blockName) {
    const block = this.mcData.blocksByName[blockName]
    if (!block || !block.harvestTools) return { ok: true }
    const ids = Object.keys(block.harvestTools).map(Number)
    const ok = this.bot.inventory.items().some(i => ids.includes(i.type))
    const names = ids.map(id => this.mcData.items[id] && this.mcData.items[id].name).filter(Boolean)
    const order = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
    names.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    return { ok, tools: names }
  }

  // ---------- mining & collecting ----------
  async cmdMine (phrase, count, isWood) {
    const bot = this.bot
    if (bot.game.gameMode === 'spectator') { this.reply("I'm in spectator mode, so I can't break blocks.") ; return }
    if (bot.game.gameMode === 'adventure') { this.reply("I'm in adventure mode — this server doesn't let me break blocks here.") ; return }
    const names = this.resolveBlockNames(phrase)
    if (!names.length) { this.reply(`I don't know a block called "${phrase}".`) ; return }
    const ids = names.map(n => this.mcData.blocksByName[n].id)
    const label = isWood ? 'wood' : names[0].replace(/_/g, ' ')
    count = Math.max(1, Math.min(count || 1, 64))

    this.reply(isWood ? 'Checking inventory and starting the task.' : `Checking inventory before mining ${count} ${label}.`)
    const before = this.invMap()
    const haveLogs = this.count(n => /_log$|_stem$/.test(n))
    if (isWood) this.log('info', `Inventory check: ${haveLogs} logs before starting.`)

    // tools
    if (bot.game.gameMode !== 'creative') {
      const tool = this.hasHarvestTool(names[0])
      if (!tool.ok) {
        const cheapest = tool.tools[0]
        const msg = `Mining ${label} needs a ${cheapest ? cheapest.replace(/_/g, ' ') : 'better tool'} (or better), and I don't have one — without it the block drops nothing.`
        if (cheapest === 'wooden_pickaxe' || cheapest === 'stone_pickaxe') {
          this.ask(`${msg} Should I craft a ${cheapest.replace(/_/g, ' ')} first? I'll check what materials that needs.`, async () => {
            const made = await this.cmdCraft(cheapest, 1, { silentPlan: false, autoConfirm: true })
            if (made) await this.cmdMine(phrase, count, isWood)
          })
        } else this.reply(msg)
        return
      }
    }

    const found = bot.findBlocks({ matching: ids, maxDistance: 64, count: 256 })
    if (!found.length) {
      this.reply(isWood ? "I can't see any trees within 64 blocks. Move me near a forest (or say explore) and try again." : `There's no ${label} within 64 blocks of me.`)
      return
    }
    const token = this.beginTask(isWood ? `collecting ${count} wood` : `mining ${count} ${label}`)
    const startPos = bot.entity.position.clone()
    let broken = 0
    const skip = new Set()
    let failures = 0
    let denied = 0
    try {
      while (!token.cancelled && broken < count && failures < 8) {
        const targets = bot.findBlocks({ matching: ids, maxDistance: 64, count: 256 }).filter(p => !skip.has(p.toString()))
        if (!targets.length) break
        const me = bot.entity.position
        targets.sort((a, b) => (a.distanceTo(me) + Math.max(0, a.y - me.y) * 2) - (b.distanceTo(me) + Math.max(0, b.y - me.y) * 2))
        const pos = targets[0]
        const block = bot.blockAt(pos)
        if (!block || !ids.includes(block.type)) { skip.add(pos.toString()); continue }
        try {
          await this.gotoGoal(new goals.GoalLookAtBlock(pos, bot.world, { reach: 4.2 }), token, 30000)
        } catch (e) {
          if (e.cancelled) throw e
          skip.add(pos.toString()); failures++
          this.log('warn', `Can't reach ${block.name} at ${pos} (${e.message}), skipping it.`)
          continue
        }
        this.check(token)
        if (bot.tool) { try { await bot.tool.equipForBlock(block, { requireHarvest: false }) } catch {} }
        if (!bot.canDigBlock(block)) { skip.add(pos.toString()); failures++; continue }
        try {
          await bot.dig(block, true)
        } catch (e) {
          this.check(token)
          skip.add(pos.toString()); failures++
          this.log('warn', `Digging ${block.name} failed: ${e.message}`)
          continue
        }
        await sleep(350)
        const after = bot.blockAt(pos)
        if (after && ids.includes(after.type)) {
          denied++; skip.add(pos.toString()); failures++
          this.log('warn', `The server put the ${block.name} back after I broke it.`)
          if (denied >= 2) { this.reply("The server keeps restoring the blocks I break, so I don't have permission to break blocks here (spawn protection, a land claim, or a plugin). I stopped.") ; break }
          continue
        }
        broken++
        failures = 0
        this.log('info', `Broke ${block.name} at ${pos.x}, ${pos.y}, ${pos.z} (${broken}/${count}).`)
        await this.pickupDrops(pos, token)
      }
      this.check(token)
      await this.pickupDrops(null, token)
      const gained = this.diffInventory(before)
      if (!broken) {
        this.reply(isWood ? "I couldn't reach any tree logs I could break (they may be too high or blocked). Nothing was collected." : `I couldn't break any ${label}. Nothing was collected.`)
      } else {
        const got = gained.length ? this.fmtItems(gained) : 'nothing (the drops did not reach my inventory)'
        const total = isWood ? ` I now have ${this.count(n => /_log$|_stem$/.test(n))} logs.` : ''
        const short = broken < count ? ` I could only find/reach ${broken} of ${count}.` : ''
        this.reply(`Done: mined ${broken} ${isWood ? nice('log', broken) : nice(label, broken)}. Inventory gained ${got} (counts anything I broke on the way too).${total}${short}`)
      }
      await this.climbBack(startPos, token)
    } catch (e) {
      if (!e.cancelled) this.reply(`Mining stopped: ${e.message}`)
      else {
        const gained = this.diffInventory(before)
        if (gained.length) this.log('info', `Picked up before stopping: ${this.fmtItems(gained)}.`)
      }
    } finally { this.endTask(token) }
  }

  // Mining often leaves the bot at the bottom of a shaft it dug. Walking alone can't get
  // out of a 1-wide shaft, so climb back to where the task started, placing blocks the
  // bot just mined (dirt, cobblestone…) under itself if needed. Only runs when the bot
  // ended more than 2 blocks below its starting point.
  async climbBack (startPos, token) {
    const bot = this.bot
    if (!bot || !bot.entity || bot.entity.position.y > startPos.y - 2) return
    const s = this.ctx.settings()
    const fillers = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'sand', 'gravel']
      .map(n => this.mcData.itemsByName[n]).filter(Boolean).map(i => i.id)
    const temp = new Movements(bot)
    temp.canDig = !!s.allowDiggingWhilePathing
    temp.allow1by1towers = true
    temp.scafoldingBlocks = fillers
    temp.allowParkour = true
    const haveFiller = bot.inventory.items().some(i => fillers.includes(i.type))
    this.log('info', `Climbing back up to ${startPos.x.toFixed(0)}, ${startPos.y.toFixed(0)}, ${startPos.z.toFixed(0)}${haveFiller ? ' (may place a few mined blocks to get out of the shaft)' : ''}.`)
    bot.pathfinder.setMovements(temp)
    try {
      await this.gotoGoal(new goals.GoalNear(startPos.x, startPos.y, startPos.z, 2), token, 45000)
      this.reply('Climbed back up to where I started.')
    } catch (e) {
      if (e.cancelled) throw e
      const p = bot.entity.position
      this.reply(`I'm still down in the hole I dug (at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}) — I couldn't climb out (${e.message}).${haveFiller ? '' : ' I have no dirt or cobblestone to build up with.'}`)
    } finally {
      if (this.bot === bot && this.movements) bot.pathfinder.setMovements(this.movements)
    }
  }

  async pickupDrops (near, token) {
    const bot = this.bot
    for (let i = 0; i < 6; i++) {
      this.check(token)
      const me = bot.entity.position
      const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position && e.position.distanceTo(near || me) < 6 && e.position.distanceTo(me) > 0.8)
      if (!drops.length) return
      drops.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
      const d = drops[0]
      try {
        await this.gotoGoal(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5), token, 6000)
      } catch (e) { if (e.cancelled) throw e }
      await sleep(250)
    }
  }

  // ---------- crafting ----------
  findTable (maxDistance = 32) {
    const t = this.mcData.blocksByName.crafting_table
    return this.bot.findBlock({ matching: t.id, maxDistance })
  }

  // Plans how to make `qty` of item `id` from the simulated inventory `sim`.
  // Returns { ok, steps, missing } where steps are { id, times, table }.
  plan (id, qty, sim, depth = 0, seen = new Set()) {
    const data = this.mcData
    const have = sim.get(id) || 0
    if (have >= qty) { sim.set(id, have - qty); return { ok: true, steps: [], missing: [] } }
    const need = qty - have
    if (depth > 3 || seen.has(id)) return { ok: false, steps: [], missing: [[data.items[id].name, need]] }
    const recipes = this.bot.recipesAll(id, null, true)
    if (!recipes.length) return { ok: false, steps: [], missing: [[data.items[id].name, need]] }
    let best = null
    const tried = new Set()
    for (const r of recipes) {
      const sig = JSON.stringify(r.delta)
      if (tried.has(sig)) continue
      tried.add(sig)
      if (tried.size > 24) break
      const times = Math.ceil(need / r.result.count)
      const s2 = new Map(sim)
      s2.set(id, 0)
      let steps = []
      let missing = []
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const sub = this.plan(d.id, -d.count * times, s2, depth + 1, new Set([...seen, id]))
        steps = steps.concat(sub.steps)
        missing = missing.concat(sub.missing)
      }
      const cand = { ok: missing.length === 0, steps: [...steps, { id, times, table: !!r.requiresTable, makes: times * r.result.count }], missing, sim: s2, extra: times * r.result.count - need }
      if (!best || (cand.ok && !best.ok) || (cand.ok === best.ok && (cand.missing.length < best.missing.length || (cand.missing.length === best.missing.length && cand.steps.length < best.steps.length)))) best = cand
      if (best.ok && best.steps.length === 1) break
    }
    if (best.ok) {
      for (const [k, v] of best.sim) sim.set(k, v)
      sim.set(id, (sim.get(id) || 0) + best.extra)
    }
    return best
  }

  async cmdCraft (phrase, count = 1, opts = {}) {
    const bot = this.bot
    const data = this.mcData
    const r = this.resolveItemName(phrase)
    if (!r) { this.reply(`I don't know an item called "${phrase}".`) ; return false }
    const name = r.name || this.pickFromFamily(r.family)
    const item = data.itemsByName[name]
    count = Math.max(1, Math.min(count || 1, 64))
    const recipes = bot.recipesAll(item.id, null, true)
    if (!recipes.length) { this.reply(`${name.replace(/_/g, ' ')} can't be crafted (it's smelted, found or traded instead).`) ; return false }

    this.reply(`Checking inventory for ${count} ${nice(name, count)}…`)
    const before = this.invMap()
    const sim = this.invMap()
    // count the target as zero so we really craft `count` more
    const already = sim.get(name) || 0
    sim.set(name, 0)
    const sims = new Map([...sim].map(([k, v]) => [data.itemsByName[k] ? data.itemsByName[k].id : -1, v]))
    const p = this.plan(item.id, count, sims)
    if (!p.ok) {
      const miss = p.missing.reduce((acc, [n, c]) => { acc[n] = (acc[n] || 0) + c; return acc }, {})
      const list = Object.entries(miss).map(([n, c]) => `${c} × ${n.replace(/_/g, ' ')}`).join(', ')
      this.reply(`I can't craft ${count} ${nice(name, count)} yet. Missing: ${list}. ${/log/.test(list) ? 'Say "collect wood" to get logs.' : ''}`.trim())
      return false
    }
    const needsTable = p.steps.some(s => s.table)
    const tableNear = needsTable ? this.findTable(32) : null
    let tableSteps = []
    if (needsTable && !tableNear) {
      const tableId = data.itemsByName.crafting_table.id
      const haveTable = (sims.get(tableId) || 0) > 0
      if (!haveTable) {
        const tp = this.plan(tableId, 1, sims)
        if (!tp.ok) {
          const list = tp.missing.map(([n, c]) => `${c} × ${n.replace(/_/g, ' ')}`).join(', ')
          this.reply(`${name.replace(/_/g, ' ')} needs a crafting table. There's none near me and I can't make one (missing ${list}).`)
          return false
        }
        tableSteps = tp.steps
      }
      tableSteps = tableSteps.concat([{ place: true }])
    }
    const allSteps = [...tableSteps, ...p.steps]
    const extraWork = allSteps.length > 1 || tableSteps.length > 0
    const describe = allSteps.map(s => s.place ? 'place a crafting table' : `craft ${s.makes} ${nice(data.items[s.id].name, s.makes)}`).join(' → ')
    const exec = async () => {
      const token = this.beginTask(`crafting ${count} ${name.replace(/_/g, ' ')}`)
      try {
        let table = tableNear
        for (const s of allSteps) {
          this.check(token)
          if (s.place) { table = await this.placeCraftingTable(token); continue }
          await this.craftStep(s, table, token)
        }
        const now = this.invMap().get(name) || 0
        const made = now - already
        if (made >= count) this.reply(`Crafted ${made} ${nice(name, made)}. I now have ${now}.`)
        else this.reply(`I only ended up with ${Math.max(0, made)} new ${name.replace(/_/g, ' ')} (wanted ${count}).`)
        const gained = this.diffInventory(before)
        if (gained.length) this.log('info', `Inventory gained: ${this.fmtItems(gained)}.`)
        return made >= count
      } catch (e) {
        if (!e.cancelled) this.reply(`Crafting failed: ${e.message}`)
        return false
      } finally { this.endTask(token) }
    }
    if (extraWork && !opts.autoConfirm) {
      this.ask(`To make ${count} ${nice(name, count)} I need to: ${describe}. That uses materials from my inventory. Go ahead?`, exec)
      return false
    }
    if (extraWork) this.reply(`Plan: ${describe}.`)
    return exec()
  }

  async craftStep (step, table, token) {
    const bot = this.bot
    const data = this.mcData
    const nm = data.items[step.id].name
    if (step.table) {
      if (!table) table = this.findTable(32)
      if (!table) throw new Error('no crafting table nearby')
      if (bot.entity.position.distanceTo(table.position) > 4) {
        await this.gotoGoal(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), token, 30000)
      }
    }
    const tableBlock = step.table ? table : null
    const resultCount = (bot.recipesAll(step.id, null, true)[0] || { result: { count: 1 } }).result.count
    const times = Math.ceil(step.makes / resultCount)
    const recipe = bot.recipesFor(step.id, null, 1, tableBlock)[0]
    if (!recipe) throw new Error(`I no longer have the ingredients for ${nm}`)
    const before = this.count(n => n === nm)
    await this.craftManual(recipe, times, tableBlock, token)
    let after = before
    for (let i = 0; i < 10 && after <= before; i++) { await sleep(150); after = this.count(n => n === nm) }
    if (after <= before) throw new Error(`the server didn't give me the ${nm.replace(/_/g, ' ')}`)
    this.log('info', `Crafted ${after - before} ${nm}.`)
  }

  // Crafting done click by click. mineflayer's own bot.craft() desynced on a 1.21.4
  // server during testing (it lost track of the cursor, swapped stacks, and its
  // inventory model drifted from the server's), so every ingredient is picked up,
  // one item is dropped in the grid, the rest is put straight back, and the server
  // gets time to confirm before the next read.
  async craftManual (recipe, times, tableBlock, token) {
    const bot = this.bot
    const w = tableBlock ? 3 : 2
    let win
    if (tableBlock) {
      win = await bot.openBlock(tableBlock)
      await sleep(250) // let the server send the window contents
      if (!String(win.type).startsWith('minecraft:crafting')) { try { bot.closeWindow(win) } catch {} ; throw new Error('that block did not open a crafting window') }
    } else {
      win = bot.inventory
    }
    try {
      const cells = []
      if (recipe.inShape) {
        recipe.inShape.forEach((row, y) => row.forEach((ing, x) => { if (ing.id !== -1) cells.push({ slot: 1 + x + w * y, id: ing.id }) }))
      } else {
        recipe.ingredients.forEach((ing, i) => cells.push({ slot: 1 + i, id: ing.id }))
      }
      if (cells.some(c => c.slot > w * w)) throw new Error('that recipe needs a crafting table')
      for (let t = 0; t < times; t++) {
        this.check(token)
        for (const c of cells) {
          const src = win.slots.slice(win.inventoryStart, win.inventoryEnd).find(s => s && s.type === c.id)
          if (!src) {
            this.log('warn', `Crafting window: ${win.slots.map((s, i) => s ? i + ':' + s.name + 'x' + s.count : null).filter(Boolean).join(' ')} cursor=${win.selectedItem ? win.selectedItem.name : 'empty'}`)
            throw new Error(`ran out of ${this.mcData.items[c.id].name.replace(/_/g, ' ')}`)
          }
          await bot.clickWindow(src.slot, 0, 0)
          await sleep(60)
          await bot.clickWindow(c.slot, 1, 0)
          await sleep(60)
          await bot.clickWindow(src.slot, 0, 0)
          await sleep(150) // let the server confirm before reading slots again
          if (win.selectedItem) {
            const empty = win.firstEmptyInventorySlot ? win.firstEmptyInventorySlot() : null
            if (empty != null) { await bot.clickWindow(empty, 0, 0); await sleep(100) }
          }
        }
        let ok = false
        for (let i = 0; i < 10 && !ok; i++) { await sleep(100); ok = !!(win.slots[0] && win.slots[0].type === recipe.result.id) }
        if (!ok) throw new Error('the crafting grid did not show the expected result')
        await bot.clickWindow(0, 0, 1)
        await sleep(200)
      }
      // anything left in the grid goes back to the inventory
      for (let s = 1; s <= w * w; s++) if (win.slots[s]) { await bot.clickWindow(s, 0, 1); await sleep(100) }
    } finally {
      if (tableBlock) { try { bot.closeWindow(win) } catch {} }
    }
  }

  async placeCraftingTable (token) {
    const bot = this.bot
    const item = bot.inventory.items().find(i => i.name === 'crafting_table')
    if (!item) throw new Error('no crafting table in my inventory')
    const me = bot.entity.position.floored()
    const spots = []
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (Math.abs(dx) + Math.abs(dz) === 0) continue
          const ref = me.offset(dx, dy - 1, dz)
          const target = ref.offset(0, 1, 0)
          const rb = bot.blockAt(ref); const tb = bot.blockAt(target)
          if (!rb || !tb) continue
          if (rb.boundingBox !== 'block' || tb.name !== 'air') continue
          if (target.equals(me) || target.equals(me.offset(0, 1, 0))) continue
          spots.push({ ref: rb, target, d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) })
        }
      }
    }
    spots.sort((a, b) => a.d - b.d)
    if (!spots.length) throw new Error('there is no free spot next to me to place the crafting table')
    for (const s of spots.slice(0, 4)) {
      this.check(token)
      try {
        await bot.equip(item, 'hand')
        await bot.placeBlock(s.ref, new Vec3(0, 1, 0))
      } catch (e) {
        this.log('warn', `Placing the table at ${s.target} failed: ${e.message}`)
      }
      await sleep(300)
      const b = bot.blockAt(s.target)
      if (b && b.name === 'crafting_table') { this.log('info', `Placed a crafting table at ${s.target.x}, ${s.target.y}, ${s.target.z}.`) ; return b }
    }
    throw new Error("I couldn't place the crafting table (the server may not allow building here)")
  }

  async cmdEquip (phrase) {
    const r = this.resolveItemName(phrase)
    const names = r ? (r.name ? [r.name] : r.family) : []
    const it = this.bot.inventory.items().find(i => names.includes(i.name))
    if (!it) { this.reply(`I don't have any ${phrase}.`) ; return }
    try { await this.bot.equip(it, 'hand'); this.reply(`Holding ${it.name.replace(/_/g, ' ')}.`) } catch (e) { this.reply(`Couldn't equip it: ${e.message}`) }
  }

  async cmdDrop (phrase, count) {
    const r = this.resolveItemName(phrase)
    const names = r ? (r.name ? [r.name] : r.family) : []
    const items = this.bot.inventory.items().filter(i => names.includes(i.name))
    if (!items.length) { this.reply(`I don't have any ${phrase}.`) ; return }
    const total = items.reduce((a, i) => a + i.count, 0)
    const n = count == null ? total : Math.min(count, total)
    try {
      let left = n
      for (const it of items) {
        if (left <= 0) break
        const k = Math.min(left, it.count)
        await this.bot.toss(it.type, null, k)
        left -= k
      }
      this.reply(`Dropped ${n} ${items[0].name.replace(/_/g, ' ')}.`)
    } catch (e) { this.reply(`Couldn't drop it: ${e.message}`) }
  }

  bestFood () {
    const foods = this.mcData.foodsByName || {}
    const bad = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])
    const items = this.bot.inventory.items().filter(i => foods[i.name] && !bad.has(i.name))
    items.sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0))
    return items[0] || null
  }

  async cmdEat (auto) {
    const bot = this.bot
    if (bot.food >= 20) { if (!auto) this.reply("I'm not hungry (food 20/20).") ; return }
    const food = this.bestFood()
    if (!food) { if (!auto) this.reply(`I'm at food ${bot.food}/20 but I have nothing to eat.`) ; return }
    if (this.eating) return
    this.eating = true
    try {
      await bot.equip(food, 'hand')
      await bot.consume()
      this.reply(`${auto ? 'Auto-eat: ' : ''}Ate ${food.name.replace(/_/g, ' ')}. Food is now ${bot.food}/20.`)
    } catch (e) {
      if (!auto) this.reply(`Couldn't eat: ${e.message}`)
    } finally { this.eating = false }
  }

  maybeAutoEat () {
    if (!this.ctx.settings().autoEat || !this.bot || !this.spawned) return
    if (this.bot.food <= 14 && !this.eating && !(this.task && /mining|collecting/.test(this.task.name) && this.bot.targetDigBlock)) {
      if (this.bestFood()) this.cmdEat(true).catch(() => {})
    }
  }

  async cmdSleep () {
    const bot = this.bot
    const bed = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 32 })
    if (!bed) { this.reply('There is no bed within 32 blocks of me.') ; return }
    if (bot.time.isDay && !bot.thunderState) { this.reply("It's daytime — beds only work at night or during thunderstorms.") ; return }
    const token = this.beginTask('going to bed')
    try {
      await this.gotoGoal(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), token, 30000)
      await bot.sleep(bed)
      this.reply('Sleeping in the bed. Say stop or wake to get up.')
    } catch (e) {
      if (!e.cancelled) this.reply(`Couldn't sleep: ${e.message}`)
    } finally { this.endTask(token) }
  }
}

module.exports = { JavaDriver, friendlyError }
