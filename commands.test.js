'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { parse } = require('../server/commands')

test('spec examples map to deterministic commands', () => {
  assert.deepStrictEqual(parse('Follow Steve.'), { action: 'follow', player: 'steve' })
  assert.deepStrictEqual(parse('Collect wood.'), { action: 'collect', what: 'wood', count: 4 })
  assert.deepStrictEqual(parse('Stop.'), { action: 'stop' })
})

test('common phrasings', () => {
  assert.deepStrictEqual(parse('mine 5 stone'), { action: 'mine', block: 'stone', count: 5 })
  assert.deepStrictEqual(parse('craft 4 sticks'), { action: 'craft', item: 'sticks', count: 4 })
  assert.deepStrictEqual(parse('make a crafting table'), { action: 'craft', item: 'crafting table', count: 1 })
  assert.deepStrictEqual(parse('goto 100 64 -20'), { action: 'goto', x: 100, y: 64, z: -20 })
  assert.deepStrictEqual(parse('go to 10 20'), { action: 'goto', x: 10, z: 20 })
  assert.deepStrictEqual(parse('say Hello World'), { action: 'say', message: 'Hello World' })
  assert.deepStrictEqual(parse('/spawn'), { action: 'say', message: '/spawn' })
  assert.strictEqual(parse("what's in your inventory").action, 'inventory')
  assert.strictEqual(parse('come here').action, 'come')
  assert.strictEqual(parse('explore').action, 'explore')
  assert.strictEqual(parse('jump').action, 'jump')
  assert.strictEqual(parse('yes').action, 'yes')
  assert.strictEqual(parse('dance like nobody is watching').action, 'unknown')
})
