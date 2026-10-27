import assert from 'node:assert/strict'
import test from 'node:test'

import { planOrder } from '../dist/index.js'

const meta = (rows) => new Map(Object.entries(rows))

test('sorts by creation time ascending', () => {
  const list = ['b', 'c', 'a']
  const m = meta({ a: { createdAt: 1, title: 'A' }, b: { createdAt: 2, title: 'B' }, c: { createdAt: 3, title: 'C' } })
  assert.deepEqual(planOrder(list, m, 'createdAt', 'asc'), ['a', 'b', 'c'])
})

test('sorts by creation time descending', () => {
  const list = ['b', 'c', 'a']
  const m = meta({ a: { createdAt: 1, title: 'A' }, b: { createdAt: 2, title: 'B' }, c: { createdAt: 3, title: 'C' } })
  assert.deepEqual(planOrder(list, m, 'createdAt', 'desc'), ['c', 'b', 'a'])
})

test('equal timestamps fall back to id so runs are repeatable', () => {
  const list = ['z', 'y', 'x']
  const m = meta({ x: { createdAt: 5, title: '' }, y: { createdAt: 5, title: '' }, z: { createdAt: 5, title: '' } })
  assert.deepEqual(planOrder(list, m, 'createdAt', 'asc'), ['x', 'y', 'z'])
})

test('sessions without metadata stay at the tail in their old relative order', () => {
  const list = ['loose2', 'b', 'loose1', 'a']
  const m = meta({ a: { createdAt: 1, title: 'A' }, b: { createdAt: 2, title: 'B' } })
  assert.deepEqual(planOrder(list, m, 'createdAt', 'asc'), ['a', 'b', 'loose2', 'loose1'])
})

test('sorts by title, independent of creation time', () => {
  const list = ['a', 'b', 'c']
  const m = meta({
    a: { createdAt: 3, title: 'bbb' },
    b: { createdAt: 2, title: 'aaa' },
    c: { createdAt: 1, title: 'ccc' },
  })
  assert.deepEqual(planOrder(list, m, 'title', 'asc'), ['b', 'a', 'c'])
})

test('does not mutate the input array', () => {
  const list = ['b', 'a']
  const m = meta({ a: { createdAt: 1, title: '' }, b: { createdAt: 2, title: '' } })
  planOrder(list, m, 'createdAt', 'asc')
  assert.deepEqual(list, ['b', 'a'])
})
