// Plugin display name, shown in loader diagnostics.
export const name = 'dsh-session-sorter';
// Wait for the HTTP server, the workspace registry and session metadata.
export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'connection'];
const PREFIX = '/dsh-session-sorter';
/**
 * Pure ordering step: unknown ids (no log, hence no meta) are not dropped, they
 * keep their relative order at the tail. Ties fall back to id so the result is
 * deterministic across runs.
 */
export function planOrder(sessionIds, meta, key, direction) {
    const known = sessionIds.filter((id) => meta.has(id));
    const unknown = sessionIds.filter((id) => !meta.has(id));
    known.sort((a, b) => {
        if (key === 'title') {
            const compared = (meta.get(a)?.title ?? '').localeCompare(meta.get(b)?.title ?? '');
            if (compared !== 0)
                return compared;
        }
        const byTime = (meta.get(a)?.createdAt ?? 0) - (meta.get(b)?.createdAt ?? 0);
        return byTime !== 0 ? byTime : a.localeCompare(b);
    });
    if (direction === 'desc')
        known.reverse();
    return [...known, ...unknown];
}
const sendJson = (res, status, body) => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': buf.length,
    });
    res.end(buf);
};
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.from(chunk));
    if (chunks.length === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        return null;
    }
}
export function apply(ctx) {
    const web = ctx.webServer;
    const registry = ctx.workspaceRegistry;
    const query = ctx.sessionQuery;
    const connection = ctx.connection;
    // Same browser-trust fence every first-party route uses: without it any page
    // open in the browser could POST to this port and rewrite the sidebar order.
    const trusted = (req) => {
        if (connection === undefined || typeof connection.requestRejection !== 'function')
            return true;
        try {
            return connection.requestRejection(req) === undefined;
        }
        catch {
            return false;
        }
    };
    // Workspace picker data for the panel.
    const listWorkspaces = () => registry.list().map((workspace) => ({
        id: workspace.id,
        title: workspace.title ?? null,
        path: workspace.path,
        sessionCount: workspace.sessionIds.length,
    }));
    const sortWorkspace = async (workspaceId, key, direction) => {
        const target = registry.get(workspaceId);
        if (target === undefined)
            return { ok: false, error: 'unknown workspace' };
        // `createdAt` and the display title both come from the session headers, so
        // one listing pass is enough for every key.
        const sessions = await query.listSessions();
        const meta = new Map();
        for (const entry of sessions) {
            const header = entry?.header;
            if (header?.id === undefined)
                continue;
            meta.set(header.id, { createdAt: header.createdAt ?? 0, title: String(header.title ?? '') });
        }
        let before = [];
        let after = [];
        // One mutate = one durable write. Sessions whose log is missing from the
        // listing keep their old relative position at the tail instead of being
        // dropped: `mutate()` prunes only ids that fail its own candidacy check.
        await target.mutate((record) => {
            before = [...record.sessionIds];
            after = planOrder(record.sessionIds, meta, key, direction);
            return { ...record, sessionIds: after };
        });
        return {
            ok: true,
            workspaceId,
            key,
            direction,
            total: after.length,
            moved: after.filter((id, index) => before[index] !== id).length,
            // The browser keeps manual order itself (`dsh.workspace.view.v5` →
            // `sessionOrderByAccount`), so it needs the resulting ids, not just a count.
            order: after,
        };
    };
    ctx.effect(() => {
        const disposeList = web.register({
            kind: 'exact',
            path: `${PREFIX}/workspaces`,
            handler: (req, res) => {
                if (!trusted(req)) {
                    sendJson(res, 403, { error: 'forbidden' });
                    return;
                }
                try {
                    sendJson(res, 200, { workspaces: listWorkspaces() });
                }
                catch (error) {
                    sendJson(res, 500, { error: String(error?.message ?? error) });
                }
            },
        });
        const disposeSort = web.register({
            kind: 'exact',
            path: `${PREFIX}/sort`,
            handler: async (req, res) => {
                if (!trusted(req)) {
                    sendJson(res, 403, { error: 'forbidden' });
                    return;
                }
                try {
                    if (req.method !== 'POST') {
                        sendJson(res, 405, { error: 'POST only' });
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (body === null) {
                        sendJson(res, 400, { error: 'invalid JSON body' });
                        return;
                    }
                    if (typeof body.workspaceId !== 'string' || body.workspaceId.length === 0) {
                        sendJson(res, 400, { error: 'workspaceId is required' });
                        return;
                    }
                    const key = body.key === 'title' ? 'title' : 'createdAt';
                    const direction = body.direction === 'desc' ? 'desc' : 'asc';
                    const result = await sortWorkspace(body.workspaceId, key, direction);
                    sendJson(res, result.ok ? 200 : 404, result);
                }
                catch (error) {
                    sendJson(res, 500, { error: String(error?.message ?? error) });
                }
            },
        });
        console.log('[dsh-session-sorter] routes registered');
        return () => {
            disposeList();
            disposeSort();
        };
    }, 'dsh-session-sorter: routes');
}
