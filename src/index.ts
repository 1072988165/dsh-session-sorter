// dsh-session-sorter — HOST half.
//
// Reorders a workspace's session account (`sessionIds`) by a chosen key, using
// the official single write path `Workspace#mutate()` from `@deepseek-ai/dsh-workspace`.
// The browser half (lib/client.js) renders the settings panel and calls the
// routes registered below.
//
// Why the host half is required: session order lives in the durable workspace
// registry, not in the browser. Only the host process can write it.
import type { Context } from '@deepseek-ai/cordis'

// Plugin display name, shown in loader diagnostics.
export const name = 'dsh-session-sorter'

// Wait for the HTTP server, the workspace registry and session metadata.
export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'connection']

const PREFIX = '/dsh-session-sorter'

type RouteSpec = {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: any, res: any) => void | Promise<void>
}
type WebServer = { register: (spec: RouteSpec) => () => void }

export type SortKey = 'createdAt' | 'title'
export type Direction = 'asc' | 'desc'

/** Everything the sort needs to know about one session. */
export type SessionMeta = { createdAt: number; title: string }

/**
 * Pure ordering step: unknown ids (no log, hence no meta) are not dropped, they
 * keep their relative order at the tail. Ties fall back to id so the result is
 * deterministic across runs.
 */
export function planOrder(
  sessionIds: readonly string[],
  meta: ReadonlyMap<string, SessionMeta>,
  key: SortKey,
  direction: Direction,
): string[] {
  const known = sessionIds.filter((id) => meta.has(id))
  const unknown = sessionIds.filter((id) => !meta.has(id))
  known.sort((a, b) => {
    if (key === 'title') {
      const compared = (meta.get(a)?.title ?? '').localeCompare(meta.get(b)?.title ?? '')
      if (compared !== 0) return compared
    }
    const byTime = (meta.get(a)?.createdAt ?? 0) - (meta.get(b)?.createdAt ?? 0)
    return byTime !== 0 ? byTime : a.localeCompare(b)
  })
  if (direction === 'desc') known.reverse()
  return [...known, ...unknown]
}

const sendJson = (res: any, status: number, body: unknown): void => {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
  })
  res.end(buf)
}

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

export function apply(ctx: Context) {
  const web = (ctx as unknown as { webServer: WebServer }).webServer
  const registry = (ctx as unknown as { workspaceRegistry: any }).workspaceRegistry
  const query = (ctx as unknown as { sessionQuery: any }).sessionQuery
  const connection = (ctx as unknown as {
    connection?: { requestRejection?: (req: any) => unknown }
  }).connection

  // Same browser-trust fence every first-party route uses: without it any page
  // open in the browser could POST to this port and rewrite the sidebar order.
  const trusted = (req: any): boolean => {
    if (connection === undefined || typeof connection.requestRejection !== 'function') return true
    try {
      return connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  // Workspace picker data for the panel.
  const listWorkspaces = () =>
    registry.list().map((workspace: any) => ({
      id: workspace.id,
      title: workspace.title ?? null,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length,
    }))

  const sortWorkspace = async (workspaceId: string, key: SortKey, direction: 'asc' | 'desc') => {
    const target = registry.get(workspaceId)
    if (target === undefined) return { ok: false as const, error: 'unknown workspace' }

    // `createdAt` and the display title both come from the session headers, so
    // one listing pass is enough for every key.
    const sessions = await query.listSessions()
    const meta = new Map<string, SessionMeta>()
    for (const entry of sessions) {
      const header = entry?.header
      if (header?.id === undefined) continue
      meta.set(header.id, { createdAt: header.createdAt ?? 0, title: String(header.title ?? '') })
    }

    let before: string[] = []
    let after: string[] = []

    // One mutate = one durable write. Sessions whose log is missing from the
    // listing keep their old relative position at the tail instead of being
    // dropped: `mutate()` prunes only ids that fail its own candidacy check.
    await target.mutate((record: any) => {
      before = [...record.sessionIds]
      after = planOrder(record.sessionIds, meta, key, direction)
      return { ...record, sessionIds: after }
    })

    return {
      ok: true as const,
      workspaceId,
      key,
      direction,
      total: after.length,
      moved: after.filter((id, index) => before[index] !== id).length,
    }
  }

  ctx.effect(() => {
    const disposeList = web.register({
      kind: 'exact',
      path: `${PREFIX}/workspaces`,
      handler: (req, res) => {
        if (!trusted(req)) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }
        try {
          sendJson(res, 200, { workspaces: listWorkspaces() })
        } catch (error) {
          sendJson(res, 500, { error: String((error as Error)?.message ?? error) })
        }
      },
    })

    const disposeSort = web.register({
      kind: 'exact',
      path: `${PREFIX}/sort`,
      handler: async (req, res) => {
        if (!trusted(req)) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          const body = await readJsonBody(req)
          if (body === null) {
            sendJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          if (typeof body.workspaceId !== 'string' || body.workspaceId.length === 0) {
            sendJson(res, 400, { error: 'workspaceId is required' })
            return
          }
          const key: SortKey = body.key === 'title' ? 'title' : 'createdAt'
          const direction: 'asc' | 'desc' = body.direction === 'desc' ? 'desc' : 'asc'
          const result = await sortWorkspace(body.workspaceId, key, direction)
          sendJson(res, result.ok ? 200 : 404, result)
        } catch (error) {
          sendJson(res, 500, { error: String((error as Error)?.message ?? error) })
        }
      },
    })

    console.log('[dsh-session-sorter] routes registered')
    return () => {
      disposeList()
      disposeSort()
    }
  }, 'dsh-session-sorter: routes')
}
