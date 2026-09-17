/**
 * The red pin: what `BOT_CROSSING_MODE=display` must do, written down before it exists.
 *
 * A display colony is fed by a laptop instead of by the disk under it, and it must be
 * incapable of acting on anything. That is four separate promises — ingest, serve-redacted,
 * refuse-to-spawn, refuse-a-bad-token — asserted here as one test so the pin is a single
 * thing to pull out when display mode lands.
 *
 * OBSERVED AGAINST 5653d84, in this order:
 *   1. POST /api/sync, right bearer, no Origin  → 403 {"error":"Bot Crossing only answers its
 *      own page on this machine"}. The Host/Origin gate refuses a POST carrying no Origin long
 *      before anything looks for a route called /api/sync, so the token is never compared and
 *      <dir>/snapshots/test-machine.json is ENOENT. (With a local Origin added it reaches the
 *      router and answers 404 {"error":"Unknown endpoint"} — there is no such endpoint.)
 *   2. GET /api/threads, Host: colony.example, no Origin → 403, same body. colony.example is
 *      not in LOCAL_HOSTS, and a GET is the one thing the gate would otherwise have allowed.
 *   3. POST /api/open, Origin http://localhost:<port>, body { harness, ref: {} } → 400
 *      {"ok":false,"error":"No openable session id on that thread"}. Note what that means: the
 *      request got all the way to the harness adapter. A ref with real session ids in it would
 *      have spawned a terminal on this machine.
 *   4. POST /api/sync, wrong bearer, no Origin → 403, same body as 1. A wrong token and a
 *      right one are indistinguishable today, because neither is looked at.
 *
 * Marked `{ todo: true }` so `npm test` stays green until WP-A flips it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const PUBLIC_HOST = 'colony.example'
const MACHINE = 'test-machine'
const MODE_VARS = ['BOT_CROSSING_DATA', 'BOT_CROSSING_MODE', 'BOT_CROSSING_SYNC_TOKEN', 'BOT_CROSSING_PUBLIC_HOST']

/**
 * The `withServer` shape from state.test.mjs — fresh data dir, cache-busted import, real
 * socket — with two changes the display contract forces.
 *
 * The mode variables are set *before* the import, because the server reads them once at module
 * load. And `call` is `http.request` rather than `fetch`: undici silently drops a `Host` header
 * you hand it (verified — it sends the socket's authority instead), and the whole of assertion
 * 2 is about the server seeing a public hostname. Nothing but `Content-Type` is sent unasked,
 * because in display mode it is the *absence* of an Origin that has to be allowed on
 * `/api/sync` and on the wall's own GET.
 */
async function withDisplayServer(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-display-'))
  const before = Object.fromEntries(MODE_VARS.map((k) => [k, process.env[k]]))
  process.env.BOT_CROSSING_DATA = dir
  process.env.BOT_CROSSING_MODE = 'display'
  process.env.BOT_CROSSING_SYNC_TOKEN = 'test-token'
  process.env.BOT_CROSSING_PUBLIC_HOST = PUBLIC_HOST
  const { apiMiddleware } = await import(`../server/api.mjs?${dir}`)
  const server = http.createServer((req, res) => apiMiddleware(req, res, null))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const call = (p, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const opts = { host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', ...headers } }
      const req = http.request(opts, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(text || '{}'), text }))
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })

  try {
    await run({ call, dir, port })
  } finally {
    server.close()
    // node --test gives each file its own process, but a leaked BOT_CROSSING_MODE would make
    // this the most confusing failure in the suite, so put them back anyway.
    for (const k of MODE_VARS) {
      if (before[k] === undefined) delete process.env[k]
      else process.env[k] = before[k]
    }
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

/**
 * A title that is 2 KB of pasted stack trace, a project called `unknown` and a
 * `lastActivityAt` of 0 are all real — people paste crashes into Claude Code, and a thread the
 * harness has never watched move sorts at the bottom with a zero. Two tidy rows would prove
 * only that the tidy case works.
 */
const stackTrace = Array.from(
  { length: 24 },
  (_, i) => `    at Object.<anonymous> (/repo/packages/core/src/render/frame-${i}.mjs:${i * 7 + 3}:${i + 11})`
).join('\n')

/** Shaped like `toThread` in server/harnesses/claude-code.mjs, carrying every field redaction drops. */
const thread = (over) => ({
  id: 'claude-code:11111111-2222-3333-4444-555555555555',
  title: 'Wire the hex plot labels',
  preview: 'the labels on the plots drift when the camera orbits, can you pin them to the plot',
  project: 'bot-crossing',
  projectPath: '/Users/someone/repos/bot-crossing',
  worktree: '',
  cwd: '/Users/someone/repos/bot-crossing',
  gitBranch: 'feat/labels',
  model: 'opus',
  effort: 'high',
  createdAt: 1758000000000,
  lastActivityAt: 1758123456789,
  lastFocusedAt: 1758123000000,
  running: false,
  unread: true,
  hasError: false,
  starred: false,
  routine: '',
  prState: '',
  archived: false,
  hasTranscript: true,
  sizeBytes: 481203,
  source: 'desktop',
  canOpen: true,
  ref: {
    desktopSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    desktopSessionIds: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    cliSessionId: '11111111-2222-3333-4444-555555555555',
    cwd: '/Users/someone/repos/bot-crossing',
  },
  ...over,
})

const t1 = thread({})
const t2 = thread({
  id: 'claude-code:99999999-8888-7777-6666-555555555555',
  title: `TypeError: Cannot read properties of undefined (reading 'geometry')\n${stackTrace}`,
  preview: 'why does this blow up on the second frame',
  project: 'unknown',
  lastActivityAt: 0,
  lastFocusedAt: 0,
  canOpen: false,
  ref: {
    desktopSessionId: '',
    desktopSessionIds: [],
    cliSessionId: '99999999-8888-7777-6666-555555555555',
    cwd: '/private/tmp/scratch',
  },
})

test('a display colony takes a push, serves it redacted, and can do nothing else', { todo: true }, async () => {
  await withDisplayServer(async ({ call, dir, port }) => {
    // 1 — the push. No Origin: the bearer token is the whole gate on this path, because the
    // caller is a launchd agent on a laptop, not a browser.
    const pushed = await call('/api/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({ machine: MACHINE, scannedAt: Date.now(), threads: [t1, t2] }),
    })
    assert.equal(pushed.status, 200, 'a correctly-signed push is accepted')
    await fsp.stat(path.join(dir, 'snapshots', `${MACHINE}.json`))

    // 2 — the wall reading it back, exactly as it arrives through an ingress: the public
    // hostname, and no Origin at all because it is a top-level navigation's own fetch.
    const res = await call('/api/threads', { headers: { Host: PUBLIC_HOST } })
    assert.equal(res.status, 200, 'the public hostname is allowed in display mode')
    const body = res.json()
    assert.equal(body.threads.length, 2, 'both pushed threads come back')
    assert.equal(body.mode, 'display', 'this is how the page learns to hide everything that acts')
    for (const t of body.threads) {
      // Not "empty" — absent. A `preview: ''` would still mean the prompt made the trip once.
      assert.ok(!('preview' in t), `${t.id} still carries a preview`)
      assert.ok(!('cwd' in t), `${t.id} still carries a cwd`)
      assert.ok(!('projectPath' in t), `${t.id} still carries a projectPath`)
      assert.deepEqual(t.ref, {}, `${t.id} still carries session ids`)
    }

    // 3 — refused outright, not merely hidden in the page. Today this reaches the harness.
    const opened = await call('/api/open', {
      method: 'POST',
      headers: { Origin: `http://localhost:${port}` },
      body: JSON.stringify({ harness: 'claude-code', ref: {} }),
    })
    assert.equal(opened.status, 403, 'a display colony cannot open anything')

    // 4 — and a push with the wrong token is a 401: turned away for the token, not for the
    // headers, so the sync agent's log says something true when the token is rotated.
    const forged = await call('/api/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: JSON.stringify({ machine: MACHINE, scannedAt: Date.now(), threads: [t1] }),
    })
    assert.equal(forged.status, 401, 'a wrong token is turned away')
  })
})
