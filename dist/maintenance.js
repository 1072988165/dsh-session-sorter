// dsh-session-sorter — HOST half: keep `createdAt` aligned with last activity.
//
// The sidebar does not sort by "last updated": the session serializer compares
// `header.createdAt` (`compareSessions` in the app bundle), while the timestamp
// printed next to each row comes from `updatedAt`. A session that keeps getting
// prompts therefore never moves up, and after a bulk import every restored
// conversation looks scrambled.
//
// This pass rewrites the log header's `createdAt` to the session's last activity
// time, which is the value the sidebar actually orders by. It only touches logs
// whose header is behind the list metadata, so a normal start is a no-op.
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
/** Placement of one session log inside the sessions root. */
export const LOG_DIR = /^session\.v\d+\.jsonl(\.zstd)?$/;
const DEFAULT_SETTLE_MS = 3 * 60_000;
const DEFAULT_SLACK_MS = 60_000;
/** True when the header's creation stamp is meaningfully behind the listing. */
export function shouldSync(createdAt, updatedAt, slackMs = DEFAULT_SLACK_MS) {
    return Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt - createdAt > slackMs;
}
/**
 * Rewrite the first log line with a new `createdAt`, leaving every other byte
 * of the log untouched. Returns the input when the line is unusable.
 */
export function rewriteHeaderLine(line, createdAt) {
    let header;
    try {
        header = JSON.parse(line);
    }
    catch {
        return line;
    }
    if (typeof header !== 'object' || header === null || header.type !== 'session')
        return line;
    header.createdAt = createdAt;
    return JSON.stringify(header);
}
/** Split a decompressed log into its header line and the remaining lines. */
export function splitLog(text) {
    const lines = text.split('\n');
    if (lines.length === 0 || lines[0].trim() === '')
        return undefined;
    return { header: lines[0], rest: lines.slice(1) };
}
export function sessionsRoot() {
    return join(homedir(), '.dsh', 'sessions');
}
/** Index every session log under the sessions root by its session id. */
export async function listLogs(root = sessionsRoot()) {
    const index = new Map();
    const workspaces = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const workspace of workspaces) {
        if (!workspace.isDirectory())
            continue;
        const workspaceDir = join(root, workspace.name);
        const sessions = await readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
        for (const session of sessions) {
            if (!session.isDirectory())
                continue;
            const files = await readdir(join(workspaceDir, session.name)).catch(() => []);
            const logs = files.filter((file) => LOG_DIR.test(file)).map((file) => join(workspaceDir, session.name, file));
            if (logs.length > 0)
                index.set(session.name, logs.sort().reverse());
        }
    }
    return index;
}
/** Node-side io: decompresses `.zstd` logs through the bundled zstd CLI. */
export function nodeIo(root = sessionsRoot()) {
    return {
        logs: () => listLogs(root),
        read: async (path) => {
            if (path.endsWith('.zstd')) {
                const { stdout } = await run('zstd', ['-dc', path], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
                return stdout.toString('utf8');
            }
            return readFile(path, 'utf8');
        },
        write: async (path, text) => {
            if (path.endsWith('.zstd')) {
                const plain = `${path}.tmp`;
                await writeFile(plain, text, 'utf8');
                try {
                    await run('zstd', ['-q', '-f', '-3', plain, '-o', `${path}.new`]);
                    await rename(`${path}.new`, path);
                }
                finally {
                    await unlink(plain).catch(() => { });
                    await unlink(`${path}.new`).catch(() => { });
                }
                return;
            }
            await writeFile(path, text, 'utf8');
        },
        mtimeMs: async (path) => (await stat(path)).mtimeMs,
        now: () => Date.now(),
        remember: async (sessionId, originalCreatedAt) => {
            const dir = join(homedir(), '.dsh', 'dsh-session-sorter');
            await mkdir(dir, { recursive: true });
            await appendFile(join(dir, 'created-at-origins.jsonl'), `${JSON.stringify({ sessionId, originalCreatedAt, at: Date.now() })}\n`, 'utf8');
        },
    };
}
/**
 * Align every drifted session header with its last activity time.
 *
 * Runs at most once per start, in the background: failures are counted, never
 * thrown, because a broken maintenance pass must not keep the app from opening.
 */
export async function syncCreatedAt(sessions, io, options = {}) {
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    const slackMs = options.slackMs ?? DEFAULT_SLACK_MS;
    const result = { scanned: 0, fixed: 0, failed: 0 };
    const drifted = sessions.filter((entry) => {
        const id = entry.header?.id ?? entry.sessionId;
        if (typeof id !== 'string' || id === '')
            return false;
        return shouldSync(entry.header?.createdAt ?? 0, entry.updatedAt ?? 0, slackMs);
    });
    if (drifted.length === 0)
        return result;
    const index = await io.logs();
    for (const entry of drifted) {
        const id = (entry.header?.id ?? entry.sessionId);
        const path = index.get(id)?.[0];
        if (path === undefined)
            continue;
        result.scanned += 1;
        try {
            if (io.now() - (await io.mtimeMs(path)) < settleMs)
                continue;
            const text = await io.read(path);
            const parts = splitLog(text);
            if (parts === undefined)
                continue;
            const header = rewriteHeaderLine(parts.header, entry.updatedAt);
            if (header === parts.header)
                continue;
            await io.remember?.(id, entry.header?.createdAt ?? 0);
            await io.write(path, [header, ...parts.rest].join('\n'));
            result.fixed += 1;
        }
        catch {
            result.failed += 1;
        }
    }
    return result;
}
