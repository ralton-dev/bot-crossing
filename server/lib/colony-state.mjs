/**
 * `data/colony.json` — read, migrate, write, and the one rule that reads it back.
 *
 * Lifted out of `api.mjs` unchanged because the laptop sync agent needs `reconcileArchived`
 * too: it pushes threads that already agree with its own colony about who has walked back
 * into the ship, so the wall does not have to.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Read per call, not once at module load. `BOT_CROSSING_DATA` never moves in a real
 * deployment, but the tests stand up one server per temp directory and defeat the module cache
 * with a query string on `api.mjs` — which does nothing for a plain `import` of *this* file, so
 * a constant here would hand every one of those servers the first one's directory.
 */
export const dataDir = () => process.env.BOT_CROSSING_DATA || path.join(here, '..', '..', 'data')
export const stateFile = () => path.join(dataDir(), 'colony.json')

export const STATE_VERSION = 2

/**
 * v1 keyed everything on a bare session id, because Claude Code was the only harness and its
 * ids are UUIDs. Adapters now prefix (`claude-code:…`, `codex:…`) so two harnesses can never
 * name the same thread, which means a v1 file's archive list no longer matches anything.
 *
 * Only Claude Code ever wrote a bare id, so the rewrite is unambiguous. One shot, on read.
 */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const migrateId = (id) => (BARE_UUID.test(id) ? `claude-code:${id}` : id)

function migrate(raw) {
  if (Number(raw.version) >= 2) return raw
  const keys = (o) => Object.fromEntries(Object.entries(asObject(o)).map(([k, v]) => [migrateId(k), v]))
  return {
    ...raw,
    archived: asArray(raw.archived).map(migrateId),
    archivedAt: keys(raw.archivedAt),
    opened: asArray(raw.opened).map(migrateId),
    seen: keys(raw.seen),
    viewedAt: keys(raw.viewedAt),
  }
}

/**
 * Colony state is only ever the things the *game* invents — which plot a project got,
 * what a thread's building looks like, what you archived, which repos you took off the map.
 * The threads themselves stay
 * read-only: this file is the only thing Bot Crossing writes, anywhere.
 */
export const emptyState = () => ({
  version: STATE_VERSION,
  archived: [],
  archivedAt: {},
  opened: [],
  plots: {},
  seen: {},
  hiddenProjects: [],
  viewedAt: {},
  settings: null,
  updatedAt: 0,
})

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])

export async function readState() {
  try {
    const raw = migrate(JSON.parse(await fsp.readFile(stateFile(), 'utf8')))
    return {
      version: STATE_VERSION,
      archived: asArray(raw.archived),
      archivedAt: asObject(raw.archivedAt),
      opened: asArray(raw.opened),
      plots: asObject(raw.plots),
      seen: asObject(raw.seen),
      hiddenProjects: asArray(raw.hiddenProjects).map(String).filter(Boolean),
      viewedAt: asObject(raw.viewedAt),
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

/**
 * One writer: the browser owns this file and PUTs it whole. Nothing on the server writes it —
 * if anything did, the next save from a page holding older state would silently drop every
 * archive made since that page loaded.
 */
/**
 * Writes are serialised through one chain, and each gets its own temp file.
 *
 * Both halves matter and neither is theoretical. A shared `colony.json.tmp` means two saves
 * landing together race on the rename and one throws ENOENT — a 500 the page has no idea what
 * to do with, so the save is simply lost. And read-then-write is not atomic across an `await`,
 * so without the chain two callers can both pass the version check below before either writes.
 */
let writeQueue = Promise.resolve()
let tmpSeq = 0
export const serialise = (fn) => (writeQueue = writeQueue.then(fn, fn))

export async function writeState(next) {
  const state = {
    version: STATE_VERSION,
    archived: asArray(next.archived),
    archivedAt: asObject(next.archivedAt),
    opened: asArray(next.opened),
    plots: asObject(next.plots),
    seen: asObject(next.seen),
    hiddenProjects: asArray(next.hiddenProjects).map(String).filter(Boolean),
    viewedAt: asObject(next.viewedAt),
    settings: next.settings && typeof next.settings === 'object' ? next.settings : null,
    updatedAt: Date.now(),
  }
  const file = stateFile()
  await fsp.mkdir(dataDir(), { recursive: true })
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return state
}

/**
 * Mark the threads the colony has retired.
 *
 * Nothing is written anywhere. Bot Crossing used to set `isArchived` on the desktop app's own
 * session record, and it did land on disk — but the app serves from the copy it loaded at
 * launch, so the thread stayed put in its own list until the next restart, and the app would
 * rewrite the record from memory whenever it touched the thread. Papering over that took a
 * re-assert on every poll, a `ps` sweep to guess whether the app had re-read the file, and a
 * *pending* state for the gap between the two — a lot of machinery for something that still
 * looked broken to anyone with the app open.
 *
 * So the colony keeps its own list and that is all it does. Archiving in the harness's own UI
 * still sends the astronaut home, because the scan reads that flag; archiving here is the
 * colony's own business. Nothing outside `data/colony.json` is ever written.
 */
export async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  /**
   * An archive is remembered by the thread id the page saw, but that id is only the *canonical*
   * one. A thread the desktop app knows and the CLI has not written a transcript for is keyed on
   * its desktop record; the moment a transcript appears it re-keys to that session's UUID, and a
   * list keyed on the old string stops matching. The thread quietly comes back, which reads as
   * the archive having failed.
   *
   * So the ids inside `ref` count too. They are opaque to everything else here — this only ever
   * asks whether a string it already holds appears among them.
   */
  const archived = (thread) => {
    if (wanted.has(thread.id)) return true
    const ref = thread.ref
    if (!ref || typeof ref !== 'object') return false
    for (const value of Object.values(ref)) {
      if (typeof value === 'string') {
        if (value && wanted.has(value)) return true
      } else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === 'string' && v && wanted.has(v)) return true
      }
    }
    return false
  }

  return threads.map((t) => (archived(t) ? { ...t, archived: true } : t))
}
