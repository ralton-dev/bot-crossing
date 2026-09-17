/**
 * The laptop half of a wall display: scan, redact, push, repeat.
 *
 * Everything this does the local server already did — `scanThreads()` walks the same harness
 * folders, `reconcileArchived` applies the same `colony.json` — with one difference that is the
 * whole point: nothing here answers a request. It is a process with no socket, no page and no
 * way to be asked for anything, which is why it can hold the machine's threads and the display
 * can hold none of them.
 *
 * It runs for weeks under launchd, so the failure it is written around is not a crash but a
 * sulk: the wall being unreachable for an afternoon must cost one log line per attempt and
 * nothing else. Every error path below ends in a printed line and the next tick.
 */
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { scanThreads } from './scan.mjs'
import { reconcileArchived } from './lib/colony-state.mjs'
import { redactThread } from './lib/redact.mjs'

/** The server's own rule (`server/lib/snapshots.mjs`), repeated here so a bad name fails on
 *  the laptop with the offending string in front of you rather than as a 400 from a wall. */
const MACHINE = /^[a-z0-9][a-z0-9-]{0,62}$/

const FETCH_TIMEOUT_MS = 15_000
/** Five consecutive failures is not a blip, it is the wall being down. Stop hammering it. */
const FAILURES_BEFORE_BACKOFF = 5
const BACKOFF_MS = 300_000
/**
 * The display decides "stale" from when a push *landed*, not from the `scannedAt` inside it, so
 * a colony that stopped changing still has to say so. Nothing changing is exactly what a quiet
 * laptop looks like, and it is the case where a missing heartbeat is most likely to be read as
 * the agent having died.
 */
const HEARTBEAT_MS = 300_000

/**
 * A hostname is not a filename. `os.hostname()` on a Mac is whatever was typed into Sharing —
 * curly apostrophes, spaces, a trailing `.local` — and it becomes `snapshots/<machine>.json` on
 * a disk somebody else administers, so it is squeezed into the contract's alphabet here rather
 * than argued about there.
 *
 * Truncation happens before the final trim on purpose: cutting at 63 can land on a separator,
 * and `…-pro-` fails the regex for a reason that has nothing to do with what was typed.
 */
export function machineName(raw) {
  const name = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
  if (!MACHINE.test(name)) {
    throw new Error(`machine name "${raw}" normalises to "${name}", which is not ${MACHINE}`)
  }
  return name
}

/**
 * The thing that goes on the wire, from threads that have already been through
 * `reconcileArchived` — the laptop settles who is archived, because it is the only one holding
 * the colony that knows (decision 7).
 *
 * Split out from the pushing so the redaction can be tested against a fixture instead of
 * against whatever this machine happens to have open today.
 */
export function buildSnapshot(threads, machine) {
  return { machine, scannedAt: Date.now(), threads: threads.map(redactThread) }
}

/**
 * Timestamps because this file is appended to for months by launchd, and "when did it last
 * work?" is the only question anybody ever asks it. Time of day only: the date is in the
 * filesystem and a wall agent's log is read within hours of the thing that went wrong.
 */
const say = (line) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`)

/** What went wrong, in the shape a person can act on. `fetch` says "fetch failed" and hides
 *  the useful half — ECONNREFUSED, ENOTFOUND, a bad certificate — down in `cause`. */
function describeFailure(err) {
  if (err?.name === 'TimeoutError') return `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
  const code = err?.cause?.code || err?.code
  const message = err?.message || String(err)
  return code ? `${message} (${code})` : message
}

/** Non-2xx: the server's own `{ error }` if it sent one, because `401 Bad token` and
 *  `401 Unauthorized` send you to different places. */
async function describeResponse(res) {
  let detail = res.statusText
  try {
    const body = await res.text()
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed.error === 'string') detail = parsed.error
  } catch {
    /* an ingress's HTML error page, or nothing at all */
  }
  return detail ? `${res.status} ${detail}` : String(res.status)
}

/** Scan the machine and reduce it to what is allowed to leave it. */
const snapshotNow = async (machine) => buildSnapshot(await reconcileArchived(await scanThreads()), machine)

const send = (url, token, snapshot, signal) =>
  fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
    // Two reasons to give up: the wall is wedged, or we are shutting down. `any` because a
    // launchd stop should not wait fifteen seconds on a socket nobody is listening on.
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  })

const summarise = (threads) => {
  const running = threads.filter((t) => t.running).length
  // "waiting" on the map is a thread that has said something nobody has read yet.
  const waiting = threads.filter((t) => t.unread).length
  return `${threads.length} threads (${running} running, ${waiting} waiting)`
}

async function main(argv) {
  const once = argv.includes('--once')
  const url = process.env.BOT_CROSSING_SYNC_URL || ''
  const token = process.env.BOT_CROSSING_SYNC_TOKEN || ''
  // Before the first scan: a wall agent with no destination has nothing to do but say so, and
  // half a minute of walking somebody's home directory would only bury the reason.
  const missing = [!url && 'BOT_CROSSING_SYNC_URL', !token && 'BOT_CROSSING_SYNC_TOKEN'].filter(Boolean)
  if (missing.length) {
    console.error(`bot-crossing sync: ${missing.join(' and ')} not set — nothing to push to`)
    return 1
  }

  let machine
  try {
    machine = machineName(process.env.BOT_CROSSING_MACHINE || os.hostname())
  } catch (err) {
    console.error(`bot-crossing sync: ${err.message}`)
    return 1
  }

  const interval = Math.max(1, Number(process.env.BOT_CROSSING_SYNC_INTERVAL_S) || 30) * 1000
  const shutdown = new AbortController()
  let stopping = false
  let wake = () => {}

  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  const stop = (signal) => {
    if (stopping) return
    stopping = true
    say(`${signal} — stopping`)
    shutdown.abort()
    wake()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  // One shot, and the exit code is the answer: this is what the installer runs to prove a URL
  // and a token before it puts anything into launchd, and what the tests drive.
  if (once) {
    try {
      const startedAt = Date.now()
      const snapshot = await snapshotNow(machine)
      const res = await send(url, token, snapshot, shutdown.signal)
      if (!res.ok) {
        say(`push failed: ${await describeResponse(res)}`)
        return 1
      }
      say(`pushed ${summarise(snapshot.threads)} in ${Date.now() - startedAt}ms`)
      return 0
    } catch (err) {
      say(`push failed: ${describeFailure(err)}`)
      return 1
    }
  }

  say(`pushing as "${machine}" every ${interval / 1000}s to ${url}`)

  let failures = 0
  /**
   * The last list that actually landed, serialised. `redactThread` builds its keys in one fixed
   * order every time, so string equality here *is* deep equality — and it costs one comparison
   * instead of walking five hundred objects every thirty seconds.
   */
  let lastSent = ''
  let lastSentAt = 0

  while (!stopping) {
    try {
      const snapshot = await snapshotNow(machine)
      const serialised = JSON.stringify(snapshot.threads)
      const quiet = serialised === lastSent && Date.now() - lastSentAt < HEARTBEAT_MS

      if (quiet) {
        say(`unchanged — ${summarise(snapshot.threads)}, last push ${Math.round((Date.now() - lastSentAt) / 1000)}s ago`)
      } else {
        const startedAt = Date.now()
        const res = await send(url, token, snapshot, shutdown.signal)
        if (!res.ok) throw new Error(await describeResponse(res))
        say(`pushed ${summarise(snapshot.threads)} in ${Date.now() - startedAt}ms`)
        if (failures >= FAILURES_BEFORE_BACKOFF) {
          say(`recovered after ${failures} failures — back to ${interval / 1000}s`)
        }
        failures = 0
        lastSent = serialised
        lastSentAt = Date.now()
      }
    } catch (err) {
      // A fetch aborted by our own shutdown is not a failure worth a line or a backoff step.
      if (!stopping) {
        failures += 1
        say(`push failed: ${describeFailure(err)}`)
        if (failures === FAILURES_BEFORE_BACKOFF) {
          say(`${failures} failures in a row — backing off to ${BACKOFF_MS / 1000}s`)
        }
      }
    }

    if (stopping) break
    await sleep(failures >= FAILURES_BEFORE_BACKOFF ? BACKOFF_MS : interval)
  }

  return 0
}

/**
 * Only when run, never when imported: the tests want `machineName` and `buildSnapshot` without
 * a process that starts scanning a home directory on import.
 */
const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invoked) {
  // `process.exitCode` rather than `process.exit`: an exit mid-write truncates the last log
  // line, which under launchd is the one telling you why it stopped.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(`bot-crossing sync: ${describeFailure(err)}`)
      process.exitCode = 1
    }
  )
}
