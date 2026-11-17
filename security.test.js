'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { redact, remember } = require('../server/redact')
const v = require('../server/validate')

test('auth commands are masked even when the password is unknown', () => {
  assert.strictEqual(redact('/login hunter2'), '/login ******')
  assert.strictEqual(redact('/register abc abc'), '/register ****** ******')
  assert.strictEqual(redact('/l pw'), '/l ******')
})

test('remembered secrets are scrubbed anywhere in a line', () => {
  remember('S3cretPass')
  assert.strictEqual(redact('server said S3cretPass is wrong'), 'server said ****** is wrong')
  assert.strictEqual(redact('key sk-abcdefghijklmnop'), 'key sk-******')
})

test('connection validation', () => {
  assert.deepStrictEqual(v.connection({ edition: 'java', host: 'play.example.net', username: 'Bot_1' }),
    { edition: 'java', host: 'play.example.net', port: 25565, username: 'Bot_1', version: 'auto', auth: 'offline' })
  assert.strictEqual(v.connection({ host: '10.0.0.5', username: 'Bot' }).port, 25565)
  assert.throws(() => v.connection({ edition: 'bedrock', host: '10.0.0.5', username: 'Bot' }), /Java Edition only/)
  assert.strictEqual(v.connection({ edition: 'java', host: 'mc.example.net:25570', username: 'Bot' }).port, 25570)
  assert.throws(() => v.connection({ edition: 'java', host: 'http://x', username: 'Bot' }), /without http/)
  assert.throws(() => v.connection({ edition: 'java', host: 'a b', username: 'Bot' }), /valid server address/)
  assert.throws(() => v.connection({ edition: 'java', host: '1.2.3.4', port: 0, username: 'Bot' }), /Port/)
  assert.throws(() => v.connection({ edition: 'java', host: '1.2.3.4', username: 'x' }), /3-16/)
  assert.throws(() => v.password('has space'), /spaces/)
})
