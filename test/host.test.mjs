import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../dist/index.js'

const HEADERS = [
  { header: { id: 'a', createdAt: 1, title: 'A' } },
  { header: { id: 'b', createdAt: 2, title: 'B' } },
  { header: { id: 'c', createdAt: 3, title: 'C' } },
]

function makeContext(requestRejection = () => undefined) {
  const routes = []
  const calls = { mutate: 0 }
  const workspace = {
    id: 'w1',
    sessionIds: ['b', 'c', 'a'],
    async mutate(fn) {
      calls.mutate += 1
      const next = fn({ id: 'w1', sessionIds: [...this.sessionIds] })
      this.sessionIds = next.sessionIds
    },
  }
  const ctx = {
    webServer: { register: (spec) => { routes.push(spec); return () => {} } },
    workspaceRegistry: {
      list: () => [{ id: 'w1', title: 'W1', path: '/p', sessionIds: workspace.sessionIds }],
      get: (id) => (id === 'w1' ? workspace : undefined),
    },
    sessionQuery: { listSessions: async () => HEADERS },
    connection: { requestRejection },
    effect: (fn) => { fn() },
  }
  apply(ctx)
  return { routes, workspace, calls }
}

function makeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(buf) { this.body = JSON.parse(buf.toString('utf8')) },
  }
}

function makePostReq(body) {
  return {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

const route = (routes, path) => routes.find((r) => r.path === path)

test('registers both routes', () => {
  const { routes } = makeContext()
  assert.deepEqual(routes.map((r) => r.path).sort(), ['/dsh-session-sorter/sort', '/dsh-session-sorter/workspaces'])
})

test('GET /workspaces answers the panel picker', () => {
  const { routes } = makeContext()
  const res = makeRes()
  route(routes, '/dsh-session-sorter/workspaces').handler({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.workspaces, [{ id: 'w1', title: 'W1', path: '/p', sessionCount: 3 }])
})

test('POST /sort writes the new order through mutate exactly once', async () => {
  const { routes, workspace, calls } = makeContext()
  const res = makeRes()
  await route(routes, '/dsh-session-sorter/sort').handler(
    makePostReq({ workspaceId: 'w1', key: 'createdAt', direction: 'asc' }),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(workspace.sessionIds, ['a', 'b', 'c'])
  assert.equal(res.body.moved, 3)
  assert.equal(calls.mutate, 1)
})

test('POST /sort rejects an unknown workspace', async () => {
  const { routes } = makeContext()
  const res = makeRes()
  await route(routes, '/dsh-session-sorter/sort').handler(
    makePostReq({ workspaceId: 'nope', key: 'createdAt', direction: 'asc' }),
    res,
  )
  assert.equal(res.status, 404)
  assert.equal(res.body.ok, false)
})

test('POST /sort refuses untrusted callers without touching the registry', async () => {
  const { routes, workspace, calls } = makeContext(() => new Error('not the browser'))
  const res = makeRes()
  await route(routes, '/dsh-session-sorter/sort').handler(
    makePostReq({ workspaceId: 'w1', key: 'createdAt', direction: 'asc' }),
    res,
  )
  assert.equal(res.status, 403)
  assert.equal(calls.mutate, 0)
  assert.deepEqual(workspace.sessionIds, ['b', 'c', 'a'])
})

test('POST /sort rejects non-POST methods', async () => {
  const { routes } = makeContext()
  const res = makeRes()
  await route(routes, '/dsh-session-sorter/sort').handler({ method: 'GET' }, res)
  assert.equal(res.status, 405)
})
