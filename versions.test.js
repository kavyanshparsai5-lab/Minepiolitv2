'use strict'
const test = require('node:test')
const assert = require('node:assert')
const v = require('../server/versions')

test('every protocol from 1.18.1 to the newest supported maps to a joinable version', () => {
  assert.strictEqual(v.resolveProtocol(757), '1.18.1')
  assert.strictEqual(v.resolveProtocol(758), '1.18.2')
  assert.strictEqual(v.resolveProtocol(765), '1.20.4')
  assert.strictEqual(v.resolveProtocol(769), '1.21.4')
  assert.strictEqual(v.resolveProtocol(v.MAX_PROTOCOL), v.latestSupported())
})

test('servers older than 1.18.1 get a clear message', () => {
  assert.throws(() => v.resolveProtocol(756, '1.17.1'), /older than 1\.18\.1/)
  assert.throws(() => v.resolveProtocol(47, '1.8.9'), /older than 1\.18\.1/)
  assert.throws(() => v.checkManual('1.16.5'), /older than 1\.18\.1/)
})

test('servers newer than this install get a clear update message', () => {
  assert.throws(() => v.resolveProtocol(v.MAX_PROTOCOL + 1, '99.1'), /newer than this MinePilot install supports/)
})

test('manual picker only offers 1.18.1+', () => {
  const list = v.selectableVersions()
  assert.ok(list.includes('1.18.1') && list.includes('1.18.2'))
  assert.ok(!list.includes('1.17.1') && !list.includes('1.16.5'))
  assert.strictEqual(v.checkManual('1.20.4'), '1.20.4')
})
