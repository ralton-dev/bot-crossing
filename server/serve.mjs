import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiMiddleware } from './api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, '..', 'dist')
// Duplicated from `server/api.mjs` rather than imported: the data directory is that module's
// private constant, and importing api.mjs here would drag the whole scanner in just to answer
// a readiness probe. The two lines have to agree — both are `BOT_CROSSING_DATA || <repo>/data`.
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const MODE = process.env.BOT_CROSSING_MODE || 'local'
// The only version a container really carries is the tag it was deployed under; the manifest
// passes it in. `dev` is the honest answer for a tree run by hand.
const VERSION = process.env.APP_VERSION || 'dev'
const PORT = Number(process.env.PORT) || 5274
// A display is reached from outside its container; a local colony must not be reachable at all
// from off the machine. An explicit BOT_CROSSING_HOST still wins over both.
const HOST = process.env.BOT_CROSSING_HOST || (MODE === 'display' ? '0.0.0.0' : '127.0.0.1')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Readiness is "can this process do its job", and the only thing it needs is its data
 * directory: colony.json and any pushed snapshots are the only things ever written. A mount
 * that exists but is not writable by this uid is the failure worth catching, and `stat` would
 * not catch it — so this writes and removes a real file.
 */
async function probeData() {
  const probe = path.join(DATA_DIR, '.readyz')
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(probe, String(Date.now()))
  await fsp.rm(probe, { force: true })
}

/** Resolve inside dist/ only — a request can never climb out with `..`. */
function resolveInDist(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(DIST, rel || 'index.html')
  return file === DIST || file.startsWith(DIST + path.sep) ? file : null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // Ungated, and deliberately outside `/api/`: the kubelet presents no Origin, no cookie and
  // no credentials, so a probe behind the API's host check would fail for the wrong reason.
  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, version: VERSION, mode: MODE })
  }
  if (url.pathname === '/readyz') {
    try {
      await probeData()
    } catch (err) {
      return sendJson(res, 503, { ok: false, error: String(err?.message || err) })
    }
    return sendJson(res, 200, { ok: true, version: VERSION, mode: MODE })
  }

  if (url.pathname.startsWith('/api/')) {
    return apiMiddleware(req, res, null)
  }

  let file = resolveInDist(url.pathname)
  if (!file) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
  } catch {
    file = path.join(DIST, 'index.html') // SPA fallback
  }

  try {
    const body = await fsp.readFile(file)
    const type = TYPES[path.extname(file)] || 'application/octet-stream'
    const cache = file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Bot Crossing ${VERSION} (${MODE} mode) → http://${HOST}:${PORT}`)
})
