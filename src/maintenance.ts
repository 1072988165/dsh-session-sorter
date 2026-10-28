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
import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Lines per follow-up frame; only the framing matters, not the batch size. */
const FRAME_LINES = 512

/** Split a log into frame payloads: the header alone, then line batches. */
export function frameChunks(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const chunks = [`${lines[0]}\n`]
  for (let i = 1; i < lines.length; i += FRAME_LINES) chunks.push(`${lines.slice(i, i + FRAME_LINES).join('\n')}\n`)
  return chunks
}

/** Compress one payload into a streamed (size-less, checksummed) zstd frame. */
function zstdFrame(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('zstd', ['-3', '--check', '-c', '-'])
    const out: Buffer[] = []
    child.stdout.on('data', (data: Buffer) => out.push(data))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`zstd exited with ${code}`))))
    child.stdin.end(text)
  })
}

/** Placement of one session log inside the sessions root. */
export const LOG_DIR = /^session\.v\d+\.jsonl(\.zstd)?$/

/** Session listing entry, narrowed to the two timestamps this pass needs. */
export type ListedSession = {
  sessionId?: string
  updatedAt?: number
  header?: { id?: string; createdAt?: number }
}

/** Filesystem side effects, injected so the pass stays testable without zstd. */
export type SyncIo = {
  /** Session id → log paths (already filtered to existing files). */
  logs: () => Promise<Map<string, string[]>>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  mtimeMs: (path: string) => Promise<number>
  now: () => number
  /** Optional audit trail: original `createdAt` before the first rewrite. */
  remember?: (sessionId: string, originalCreatedAt: number) => Promise<void>
}

export type SyncOptions = {
  /** Skip logs written this recently: their session may be appending right now. */
  settleMs?: number
  /** A gap smaller than this is noise, not a stale header. */
  slackMs?: number
}

export type SyncResult = { scanned: number; fixed: number; failed: number }

const DEFAULT_SETTLE_MS = 3 * 60_000
const DEFAULT_SLACK_MS = 60_000

/** True when the header's creation stamp is meaningfully behind the listing. */
export function shouldSync(createdAt: number, updatedAt: number, slackMs = DEFAULT_SLACK_MS): boolean {
  return Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt - createdAt > slackMs
}

/**
 * Rewrite the first log line with a new `createdAt`, leaving every other byte
 * of the log untouched. Returns the input when the line is unusable.
 */
export function rewriteHeaderLine(line: string, createdAt: number): string {
  let header: Record<string, unknown>
  try {
    header = JSON.parse(line) as Record<string, unknown>
  } catch {
    return line
  }
  if (typeof header !== 'object' || header === null || header.type !== 'session') return line
  header.createdAt = createdAt
  return JSON.stringify(header)
}

/** Split a decompressed log into its header line and the remaining lines. */
export function splitLog(text: string): { header: string; rest: string[] } | undefined {
  const lines = text.split('\n')
  if (lines.length === 0 || lines[0].trim() === '') return undefined
  return { header: lines[0], rest: lines.slice(1) }
}

export function sessionsRoot(): string {
  return join(homedir(), '.dsh', 'sessions')
}

/** Index every session log under the sessions root by its session id. */
export async function listLogs(root = sessionsRoot()): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>()
  const workspaces = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    const sessions = await readdir(workspaceDir, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const files = await readdir(join(workspaceDir, session.name)).catch(() => [])
      const logs = files.filter((file) => LOG_DIR.test(file)).map((file) => join(workspaceDir, session.name, file))
      if (logs.length > 0) index.set(session.name, logs.sort().reverse())
    }
  }
  return index
}

/** Node-side io: decompresses `.zstd` logs through the bundled zstd CLI. */
export function nodeIo(root = sessionsRoot()): SyncIo {
  return {
    logs: () => listLogs(root),
    read: async (path) => {
      if (path.endsWith('.zstd')) {
        const { stdout } = await run('zstd', ['-dc', path], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
        return stdout.toString('utf8')
      }
      return readFile(path, 'utf8')
    },
    write: async (path, text) => {
      if (path.endsWith('.zstd')) {
        // The app writes logs as a chain of streamed frames (header frame first,
        // then one frame per appended batch). A single frame carrying the whole
        // file — with the size in the frame header — is rejected by the session
        // reader as a corrupt log, which drops the session from the sidebar.
        const bytes = Buffer.concat(await Promise.all(frameChunks(text).map(zstdFrame)))
        await writeFile(`${path}.new`, bytes)
        try {
          const { stdout } = await run('zstd', ['-dc', `${path}.new`], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
          if (stdout.toString('utf8') !== text) throw new Error(`zstd round-trip mismatch for ${path}`)
          await rename(`${path}.new`, path)
        } finally {
          await unlink(`${path}.new`).catch(() => {})
        }
        return
      }
      await writeFile(path, text, 'utf8')
    },
    mtimeMs: async (path) => (await stat(path)).mtimeMs,
    now: () => Date.now(),
    remember: async (sessionId, originalCreatedAt) => {
      const dir = join(homedir(), '.dsh', 'dsh-session-sorter')
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, 'created-at-origins.jsonl'), `${JSON.stringify({ sessionId, originalCreatedAt, at: Date.now() })}\n`, 'utf8')
    },
  }
}

/**
 * Align every drifted session header with its last activity time.
 *
 * Runs at most once per start, in the background: failures are counted, never
 * thrown, because a broken maintenance pass must not keep the app from opening.
 */
export async function syncCreatedAt(
  sessions: readonly ListedSession[],
  io: SyncIo,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const slackMs = options.slackMs ?? DEFAULT_SLACK_MS
  const result: SyncResult = { scanned: 0, fixed: 0, failed: 0 }

  const drifted = sessions.filter((entry) => {
    const id = entry.header?.id ?? entry.sessionId
    if (typeof id !== 'string' || id === '') return false
    return shouldSync(entry.header?.createdAt ?? 0, entry.updatedAt ?? 0, slackMs)
  })
  if (drifted.length === 0) return result

  const index = await io.logs()
  for (const entry of drifted) {
    const id = (entry.header?.id ?? entry.sessionId) as string
    const path = index.get(id)?.[0]
    if (path === undefined) continue
    result.scanned += 1
    try {
      if (io.now() - (await io.mtimeMs(path)) < settleMs) continue
      const text = await io.read(path)
      const parts = splitLog(text)
      if (parts === undefined) continue
      const header = rewriteHeaderLine(parts.header, entry.updatedAt as number)
      if (header === parts.header) continue
      await io.remember?.(id, entry.header?.createdAt ?? 0)
      await io.write(path, [header, ...parts.rest].join('\n'))
      result.fixed += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}
