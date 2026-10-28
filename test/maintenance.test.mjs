// Unit tests for the createdAt maintenance pass (see src/maintenance.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { frameChunks, rewriteHeaderLine, shouldSync, syncCreatedAt } from '../dist/maintenance.js'

const header = (createdAt) => JSON.stringify({ type: 'session', version: 3, id: 'abc', createdAt })
const event = (time) => JSON.stringify({ type: 'user/message', seq: 1, time })

test('shouldSync only fires on a real gap', () => {
  assert.equal(shouldSync(1_000, 1_000), false)
  assert.equal(shouldSync(1_000, 30_000), false)
  assert.equal(shouldSync(1_000, 90_000), true)
  assert.equal(shouldSync(Number.NaN, 90_000), false)
})

test('rewriteHeaderLine keeps the rest of the header', () => {
  const out = rewriteHeaderLine(header(1), 99)
  const parsed = JSON.parse(out)
  assert.equal(parsed.createdAt, 99)
  assert.equal(parsed.id, 'abc')
  assert.equal(parsed.version, 3)
})

test('rewriteHeaderLine leaves foreign lines alone', () => {
  assert.equal(rewriteHeaderLine('not json', 99), 'not json')
  assert.equal(rewriteHeaderLine(JSON.stringify({ type: 'event' }), 99), JSON.stringify({ type: 'event' }))
})

test('syncCreatedAt rewrites drifted logs and skips settled ones', async () => {
  const files = new Map([
    ['/root/ws/stale/session.v3.jsonl', [header(1), event(90_000)].join('\n')],
    ['/root/ws/fresh/session.v3.jsonl', [header(1), event(90_000)].join('\n')],
    ['/root/ws/settled/session.v3.jsonl', [header(80_000), event(90_000)].join('\n')],
  ])
  const index = new Map([
    ['stale', ['/root/ws/stale/session.v3.jsonl']],
    ['fresh', ['/root/ws/fresh/session.v3.jsonl']],
    ['settled', ['/root/ws/settled/session.v3.jsonl']],
  ])
  const io = {
    logs: async () => index,
    read: async (path) => files.get(path),
    write: async (path, text) => void files.set(path, text),
    // "fresh" was written one minute ago, i.e. inside the settle window.
    mtimeMs: async (path) => (path.includes('/fresh/') ? 10 * 60_000 - 60_000 : 0),
    now: () => 10 * 60_000,
  }
  const sessions = [
    { header: { id: 'stale', createdAt: 1 }, updatedAt: 90_000 },
    { header: { id: 'fresh', createdAt: 1 }, updatedAt: 90_000 },
    { header: { id: 'settled', createdAt: 80_000 }, updatedAt: 90_000 },
    { header: { id: 'missing', createdAt: 1 }, updatedAt: 90_000 },
  ]

  const result = await syncCreatedAt(sessions, io, { settleMs: 3 * 60_000, slackMs: 60_000 })

  assert.equal(result.fixed, 1)
  assert.equal(result.failed, 0)
  assert.match(files.get('/root/ws/stale/session.v3.jsonl'), /"createdAt":90000/)
  assert.match(files.get('/root/ws/fresh/session.v3.jsonl'), /"createdAt":1[,}]/)
})

test('frameChunks keeps the header alone in the first frame', () => {
  const text = [header(1), event(2), event(3), ''].join('\n')
  const chunks = frameChunks(text)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], `${header(1)}\n`)
  assert.equal(chunks[1], `${event(2)}\n${event(3)}\n`)
  assert.equal(chunks.join(''), text)
})

test('frameChunks batches long logs into several follow-up frames', () => {
  const lines = [header(1), ...Array.from({ length: 1025 }, (_, i) => event(i + 2))]
  const chunks = frameChunks(`${lines.join('\n')}\n`)
  assert.equal(chunks.length, 4)
  assert.equal(chunks.join(''), `${lines.join('\n')}\n`)
})
