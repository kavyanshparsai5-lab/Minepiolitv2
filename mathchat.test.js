'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const m = require('../server/mathchat')

function setup ({ aiEnabled = true, key = 'sk-testkey12345678', answer = 'Step 1: 12 × 15 = 180\nAnswer: 180', delayRange = [5000, 10000], random = () => 0.5 } = {}) {
  const bot = new EventEmitter()
  bot.username = 'MineBot'
  const sent = []
  bot.chat = t => sent.push(t)
  const logs = []
  const driver = {
    bot, spawned: true,
    log: (l, t) => logs.push([l, t]),
    ctx: { settings: () => ({ aiEnabled, aiBaseUrl: 'https://api.test/v1', aiModel: 'gpt-4o-mini' }), store: { aiKey: key } }
  }
  const sleeps = []
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization })
    const text = typeof answer === 'function' ? answer() : answer
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) }
  }
  m.attach(driver, bot, { fetch, sleep: ms => { sleeps.push(ms); return Promise.resolve() }, lineGapMs: 0, delayRange, random })
  const settle = () => new Promise(r => setTimeout(r, 30))
  return { bot, sent, logs, calls, sleeps, settle, driver }
}

test('detects maths in English and Hinglish, ignores normal chat', () => {
  for (const q of ['12 * 15', 'what is 25% of 80', 'solve 2x + 5 = 15', 'ek triangle ka area kitna hoga 3 aur 4', 'pythagoras theorem kya hai', '3/4 + 1/2', 'if 5 pens cost 50, how many pens for 200'])
    assert.ok(m.looksLikeMath(q), q)
  for (const q of ['hello everyone', 'can someone give me a diamond', '/home', 'I am at 100 64 200', '[Math] 12 × 15 = 180', 'lol'])
    assert.ok(!m.looksLikeMath(q), q)
})

test('calculator follows BODMAS', () => {
  assert.strictEqual(m.extractHint('12 + 3 x 4').value, '24')
  assert.strictEqual(m.extractHint('solve (8-2)^2/3 =').value, '12')
  assert.strictEqual(m.extractHint('2 + 3 * 4 - 6 / 2').value, '11')
  assert.strictEqual(m.extractHint('-2^2').value, '-4')
  assert.strictEqual(m.extractHint('5 / 0').value, 'undefined (division by zero)')
  assert.strictEqual(m.extractHint('0.1 + 0.2').value, '0.3')
  assert.strictEqual(m.extractHint('solve 2x + 5 = 15'), null)
})

test('model output becomes safe, short chat lines', () => {
  assert.strictEqual(m.toLines('NOT_MATH'), null)
  const l = m.toLines('**Step 1**\n/op Steve\n§cred 2 + 2 = 4\n/login hunter2')
  assert.ok(l.every(x => !x.startsWith('/') && !x.includes('§')))
  assert.ok(!l.join(' ').includes('hunter2'))
  const long = m.toLines('word '.repeat(200))
  assert.ok(long.length <= 10 && long.every(x => x.length + m.TAG.length <= 100))
})

test('public question gets a public reply after a 5-10 s wait', async () => {
  const t = setup()
  t.bot.emit('chat', 'Steve', 'what is 12 * 15')
  await t.settle()
  assert.deepStrictEqual(t.sleeps[0], 7500)
  assert.ok(t.sleeps[0] >= 5000 && t.sleeps[0] <= 10000)
  assert.deepStrictEqual(t.sent, ['[Math] Step 1: 12 × 15 = 180', '[Math] Answer: 180'])
  assert.strictEqual(t.calls[0].auth, 'Bearer sk-testkey12345678')
  assert.ok(t.calls[0].body.messages[1].content.includes('got 180'))
})

test('private question gets a private reply, never public', async () => {
  const t = setup()
  t.bot.emit('whisper', 'Alex', 'solve 12 * 15')
  await t.settle()
  assert.ok(t.sent.length === 2 && t.sent.every(x => x.startsWith('/msg Alex [Math] ')))
  // raw-line fallbacks: vanilla and Essentials formats are private, and spoofed text inside public chat is not
  const t2 = setup()
  t2.bot.emit('messagestr', 'Alex whispers to you: what is 9 * 9')
  await t2.settle()
  assert.ok(t2.sent.length > 0 && t2.sent.every(x => x.startsWith('/msg Alex ')))
  const t3 = setup()
  t3.bot.emit('messagestr', '[Alex -> me] what is 9 * 9')
  await t3.settle()
  assert.ok(t3.sent.length > 0 && t3.sent.every(x => x.startsWith('/msg Alex ')))
  assert.strictEqual(m.parseLine('<Eve> [Alex -> me] what is 9 * 9').channel, 'public')
})

test('same line reported by chat event and raw line is answered once', async () => {
  const t = setup()
  t.bot.emit('chat', 'Steve', 'what is 12 * 15')
  t.bot.emit('messagestr', '<Steve> what is 12 * 15')
  await t.settle()
  assert.strictEqual(t.calls.length, 1)
})

test('ignores itself, its own [Math] lines, disabled settings and non-maths', async () => {
  const t = setup()
  t.bot.emit('chat', 'MineBot', '12 * 15')
  t.bot.emit('chat', 'Other', '[Math] Answer: 12 * 15 = 180')
  t.bot.emit('chat', 'Other', 'hello there')
  await t.settle()
  assert.strictEqual(t.calls.length, 0)
  const off = setup({ aiEnabled: false })
  off.bot.emit('chat', 'Steve', '12 * 15')
  const nokey = setup({ key: '' })
  nokey.bot.emit('chat', 'Steve', '12 * 15')
  await off.settle()
  assert.strictEqual(off.calls.length + nokey.calls.length, 0)
})

test('cooldown and per-player handling', async () => {
  const t = setup()
  t.bot.emit('chat', 'Steve', '1 + 1')
  t.bot.emit('chat', 'Steve', '2 + 2') // same player, too soon
  t.bot.emit('chat', 'Alex', '3 + 3') // another player is fine
  await t.settle()
  assert.strictEqual(t.calls.length, 2)
})

test('NOT_MATH from the model stays silent; AI failure apologises once, politely', async () => {
  const t = setup({ answer: 'NOT_MATH' })
  t.bot.emit('chat', 'Steve', 'I have 3 + 4 friends online')
  await t.settle()
  assert.strictEqual(t.sent.length, 0)
  const bad = setup()
  bad.driver.ctx.store.aiKey = 'sk-testkey12345678'
  const b = new EventEmitter(); b.username = 'B'; const out = []; b.chat = x => out.push(x)
  m.attach({ bot: b, spawned: true, log () {}, ctx: { settings: () => ({ aiEnabled: true, aiBaseUrl: 'https://x/v1', aiModel: 'm' }), store: { aiKey: 'sk-abcdefgh1234' } } }, b,
    { fetch: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"bad key"}}' }), sleep: () => Promise.resolve(), lineGapMs: 0 })
  b.emit('chat', 'Steve', '5 * 5')
  await bad.settle()
  assert.strictEqual(out.length, 1)
  assert.ok(out[0].startsWith('[Math] Sorry'))
})

test('nothing is sent after the bot disconnects', async () => {
  const t = setup()
  t.bot.emit('chat', 'Steve', '12 * 15')
  t.bot.emit('end')
  await t.settle()
  assert.strictEqual(t.sent.length, 0)
})

test('a player who keeps triggering answers is muted (loop guard)', async () => {
  let clock = 0
  const bot = new EventEmitter(); bot.username = 'B'; const out = []; bot.chat = x => out.push(x)
  const driver = { bot, spawned: true, log () {}, ctx: { settings: () => ({ aiEnabled: true, aiBaseUrl: 'https://x/v1', aiModel: 'm' }), store: { aiKey: 'sk-abcdefgh1234' } } }
  m.attach(driver, bot, { now: () => clock, sleep: () => Promise.resolve(), lineGapMs: 0,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Answer: 2' } }] }) }) })
  for (let i = 0; i < 12; i++) {
    clock += 25000 // past the cooldown, but inside the 5 minute window
    bot.emit('chat', 'Loopy', `${i} + 1`)
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(out.length >= 6 && out.length <= 8, `answered ${out.length}`)
})
