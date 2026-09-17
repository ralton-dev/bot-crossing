/**
 * The snapshot directory: one file per machine that pushes, and the union of them.
 *
 * This is the whole of a display colony's "disk". There is no database and no scan — the
 * threads arrive from somewhere else and sit in `<data>/snapshots/<machine>.json` until the
 * next push replaces them.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { redactThread } from './redact.mjs'

/**
 * The machine name becomes a filename, so it is checked rather than escaped. Lowercase
 * alphanumerics and hyphens cannot contain a separator or a `..`, which makes traversal
 * impossible by construction instead of by a sanitiser somebody has to keep correct. 63 chars
 * is a DNS label, which is where these names come from.
 */
const MACHINE = /^[a-z0-9][a-z0-9-]{0,62}$/

let tmpSeq = 0

/**
 * Store one push. Returns `{ ok: false, error }` rather than throwing, because every failure
 * here is the caller's fault and wants to reach them as a 400 with a reason they can act on.
 *
 * Threads are redacted on the way in even though the sync agent redacted them already: this
 * file is what gets served, and it should be safe to serve whatever wrote it.
 */
export async function writeSnapshot(dataDir, machine, body) {
  if (typeof machine !== 'string' || !MACHINE.test(machine)) {
    return { ok: false, error: 'machine must be lowercase letters, digits and hyphens, 1-63 chars' }
  }
  const src = body && typeof body === 'object' ? body : {}
  if (!Array.isArray(src.threads)) return { ok: false, error: 'threads must be an array' }
  const scannedAt = Number(src.scannedAt)
  if (!Number.isFinite(scannedAt)) return { ok: false, error: 'scannedAt must be a number' }

  const snapshot = {
    machine,
    scannedAt,
    // The push's own clock is not trusted for staleness: a laptop with a skewed clock would
    // either look permanently fresh or permanently gone. `receivedAt` is this server's.
    receivedAt: Date.now(),
    threads: src.threads.map(redactThread),
  }

  const dir = path.join(dataDir, 'snapshots')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${machine}.json`)
  // tmp + rename, as `writeState` does: a reader must never catch a half-written push, and two
  // pushes landing together must not race on a shared temp name.
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(snapshot))
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return { ok: true, machine, threads: snapshot.threads.length }
}

/** How long ago, in the register a wall display can read from across a room. */
function since(ms) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${Math.max(1, min)} min ago`
  const hours = Math.round(min / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/**
 * Every snapshot on disk, as one colony.
 *
 * No snapshots directory is an empty colony, not an error: that is exactly what a freshly
 * deployed display looks like for the thirty seconds before the first push arrives, and a 500
 * there would be a worse answer than an empty map.
 *
 * Staleness is a warning and never an error (decision 14). A laptop that shut its lid still has
 * a colony worth looking at; the wall says how old it is and carries on showing it.
 */
export async function readSnapshots(dataDir, staleAfterMs) {
  const dir = path.join(dataDir, 'snapshots')
  const names = await fsp.readdir(dir).catch(() => [])
  const now = Date.now()
  const sources = []
  let threads = []

  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    let snapshot = null
    try {
      snapshot = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))
    } catch {
      // Writes are atomic, so a file that will not parse was not written by us. Skipping it
      // keeps the rest of the colony on screen, which is the whole point of one file per push.
      continue
    }
    if (!snapshot || !Array.isArray(snapshot.threads)) continue
    const receivedAt = Number(snapshot.receivedAt) || 0
    sources.push({
      machine: String(snapshot.machine || name.replace(/\.json$/, '')),
      scannedAt: Number(snapshot.scannedAt) || 0,
      receivedAt,
      stale: now - receivedAt > staleAfterMs,
    })
    // Redacted again on read. The file on disk is not evidence of anything — a snapshot restored
    // from a backup, or dropped in by hand, gets the same treatment as one that arrived today.
    threads = threads.concat(snapshot.threads.map(redactThread))
  }

  threads.sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0))

  // One line per silent machine. With a single laptop pushing, its name says nothing the person
  // in front of the wall does not already know, so the line reads as English instead.
  const warnings = sources
    .filter((s) => s.stale)
    .map((s) => `${sources.length > 1 ? s.machine : 'Laptop'} last seen ${since(now - s.receivedAt)}`)

  return { threads, sources, warnings }
}
