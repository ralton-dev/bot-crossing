import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { openInTerminal as openInLinuxTerminal, schemeHasHandler, schemeOf } from './lib/xdg.mjs'
import { openInTerminal as openInMacTerminal, openUrl as openMacUrl } from './lib/macos.mjs'
import {
  defaultHarness,
  harnessStatus,
  newSession as harnessNewSession,
  openThread as harnessOpenThread,
  scanThreads,
} from './scan.mjs'
import { readState, reconcileArchived, serialise, writeState } from './lib/colony-state.mjs'

/**
 * Hand a `harness://…` deep link, or a folder, to whatever opens things on this OS. The
 * opener gets an argument list, never a shell string.
 *
 * Only `present()` calls this, and no harness knowledge ever reaches it: an adapter says what it
 * wants opened and this decides how, which is the seam that keeps `server/harnesses/` swappable.
 *
 * macOS's `open(1)` does both jobs, and `xdg-open` is the Linux equivalent. On Windows the
 * equivalent is ShellExecute, reached through `rundll32 url.dll,FileProtocolHandler`: a
 * registered protocol URL goes to its app and a folder opens in Explorer, with the argument
 * passed through untouched. Two more obvious routes were tried and rejected — `explorer.exe
 * <url>` silently drops any URL that carries a query string, so `code/new?folder=…` never
 * arrived, and `cmd /c start` parses its own argument line, where the `%3A%5C` escapes in that
 * same link are exactly what it expands.
 *
 * The spawn is guarded because the opener may simply not be installed — a headless Linux box
 * has no `xdg-open` — and an unhandled `error` event on a child process takes the whole server
 * down. Failing quietly is right here: there is nothing the page could do with the error, and
 * the scan path must never depend on whether presentation worked.
 */
const OPENERS = {
  darwin: ['open'],
  win32: ['rundll32', 'url.dll,FileProtocolHandler'],
  linux: ['xdg-open'],
}

function launch(target) {
  const opener = OPENERS[process.platform]
  if (!opener) return
  const [cmd, ...args] = opener
  const child = spawn(cmd, [...args, target], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

/**
 * A folder is openable only if it is still on this machine and still a directory. Paths
 * arrive from the page, which got them from a scan that may be minutes old — a repo that
 * has since been moved or deleted must fail here rather than hand the opener a dead path.
 * Absolute is judged by `path.isAbsolute` rather than a leading `/`, which no Windows path has.
 */
async function resolveFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null
  const dir = path.resolve(folder)
  const stat = await fsp.stat(dir).catch(() => null)
  return stat && stat.isDirectory() ? dir : null
}

/**
 * Show a harness's answer to "open this" — `{ ok, url, command }` — and say truthfully whether
 * anything happened.
 *
 * Windows hands the URL to the opener as before: a scheme the harness's app registers is always
 * answered there, so nothing is probed. On Linux and macOS the URL may have nowhere to go — the
 * desktop app is optional and often absent, and an opener given a scheme nobody claims either
 * exits quietly (`xdg-open`) or was fired detached with its exit code ignored (`open`), both of
 * which used to reach the page as "Opened". So there the scheme is checked first; failing that,
 * the harness's own CLI runs in a terminal, from the `command` the adapter offered alongside the
 * URL; failing that, the page is told so.
 *
 * `command.cwd` came from the page — inside `ref`, or as the folder itself — so it gets the same
 * check as any other folder the page names. There is no fallback directory on purpose:
 * `claude --resume` looks a session up under the folder it ran in, and a terminal that opens on
 * "No conversation found" and closes is worse than an error toast.
 */
async function present(result) {
  // Only the reason reaches the page: a failure may still carry the adapter's command.
  if (!result || !result.ok) return { ok: false, error: result?.error || 'Nothing to open' }

  if (process.platform === 'win32') {
    if (!result.url) return { ok: false, error: 'That harness has no deep link to open on this platform' }
    launch(result.url)
    // A note is the adapter saying it opened *something* — the repo rather than the thread.
    return { ok: true, url: result.url, note: result.note }
  }

  if (result.url) {
    if (process.platform === 'darwin') {
      // `open` says at once whether anything claims the scheme, so it is the probe as well.
      const opened = await openMacUrl(result.url)
      if (opened.ok) return { ok: true, url: result.url, note: result.note }
    } else if (await schemeHasHandler(result.url)) {
      launch(result.url)
      return { ok: true, url: result.url }
    }
  }
  if (result.command) {
    if (!result.command.cwd) return { ok: false, error: 'That thread has no folder on record to resume in' }
    const cwd = await resolveFolder(result.command.cwd)
    if (!cwd) return { ok: false, error: 'The folder that thread ran in is not on this machine any more' }
    // A folder that exists but cannot be entered fails inside every terminal alike, and the
    // terminal gets the blame; say what is actually wrong instead.
    const enterable = await fsp.access(cwd, fsp.constants.X_OK).then(() => true, () => false)
    if (!enterable) return { ok: false, error: 'The folder that thread ran in cannot be entered' }
    const openInTerminal = process.platform === 'darwin' ? openInMacTerminal : openInLinuxTerminal
    return openInTerminal(result.command.argv, cwd)
  }
  const scheme = schemeOf(result.url)
  return {
    ok: false,
    error: scheme
      ? `Nothing on this machine opens ${scheme}:// links, and there is no CLI command to run instead`
      : 'Nothing on this machine can open that',
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// The machine's own LAN addresses count as local too, so the colony can be
// served to the home network with BOT_CROSSING_HOST set. Harmless when bound
// to loopback (those hosts can't reach the server anyway), and the Host +
// Origin pairing still stops DNS rebinding and CSRF exactly as before.
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
  }
}

/** Hostname out of a `Host:` or `Origin:` value, with the port and any brackets stripped. */
function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * Only a page this server itself served may drive it. Two checks, against two different
 * attacks, both of which a localhost server with an `open`-the-desktop-app button is a
 * genuinely attractive target for:
 *
 *   - **Host** stops DNS rebinding. Binding to 127.0.0.1 is not on its own enough: an
 *     attacker who points `evil.com` at 127.0.0.1 reaches us *as a same-origin page*, and
 *     can then read every response. The rebound request still carries `Host: evil.com`.
 *   - **Origin** stops CSRF. A cross-site `fetch` with a `text/plain` body is not
 *     preflighted, so without this check any page you happened to be visiting could POST
 *     here — spawning sessions, opening Finder windows, or wiping the colony layout —
 *     even though it could never read the reply.
 *
 * A state-changing request with no `Origin` at all is refused: browsers always send one on
 * POST/PUT, so its absence means the caller is not the page. That does mean a bare `curl`
 * POST is rejected; pass `-H 'Origin: http://localhost:5274'` if you are scripting this.
 */
function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false

  const origin = req.headers.origin
  if (origin && origin !== 'null') return LOCAL_HOSTS.has(hostnameOf(origin))
  return req.method === 'GET' || req.method === 'HEAD'
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** Connect-style middleware: handles /api/*, passes everything else through. */
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' })

  if (!isLocalRequest(req)) {
    return send(res, 403, { error: 'Bot Crossing only answers its own page on this machine' })
  }

  try {
    if (url.pathname === '/api/threads' && req.method === 'GET') {
      const threads = await reconcileArchived(await scanThreads())
      // A harness that is present but cannot read its own store says so here, rather than
      // appearing healthy in the list while quietly contributing nothing.
      const warnings = (await harnessStatus()).filter((h) => h.detected && h.error).map((h) => h.error)
      return send(res, 200, { threads, scannedAt: Date.now(), warnings })
    }

    if (url.pathname === '/api/harnesses' && req.method === 'GET') {
      return send(res, 200, { harnesses: await harnessStatus() })
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readState())
    }

    /**
     * Optimistic concurrency, so a second tab cannot paste over the first one's work.
     *
     * `baseUpdatedAt` is the version the caller last agreed with. If the file no longer carries
     * it, the caller's whole-file body describes a colony that no longer exists — so the disk
     * state comes back with a 409 and the page merges against it. Merging here was the other
     * option and it is the wrong place: the server has no idea which of two `plots` layouts a
     * person actually dragged.
     *
     * The test is inequality rather than "older than", because a colony file also moves
     * *backwards* — restored from a backup, edited by hand — and a page open across that holds
     * a base newer than disk, which sails through a greater-than check and pastes the
     * pre-restore colony straight back.
     *
     * A missing or zero base is a first write and is allowed: nothing to lose on a fresh
     * install, and it keeps the endpoint drivable from `curl`.
     */
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      const base = Number(body.baseUpdatedAt) || 0
      return serialise(async () => {
        const current = await readState()
        if (base && current.updatedAt !== base) return send(res, 409, current)
        return send(res, 200, await writeState(body))
      })
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const shown = await present(await harnessOpenThread(harness, ref))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    if ((url.pathname === '/api/new-session' || url.pathname === '/api/reveal') && req.method === 'POST') {
      const { folder, harness } = await readJsonBody(req)
      const dir = await resolveFolder(folder)
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })

      if (url.pathname === '/api/reveal') {
        launch(dir)
        return send(res, 200, { ok: true })
      }
      const shown = await present(await harnessNewSession(harness || (await defaultHarness()), dir))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
}
