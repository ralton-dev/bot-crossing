/**
 * The laptop sync agent: what it puts on the wire, and what it does when the wall says no.
 *
 * Split deliberately. The redaction and the machine name are pure functions imported here and
 * tested against fixtures, because the alternative — asserting on whatever this machine has
 * open today — proves nothing on a CI runner with an empty home directory, where `scanThreads()`
 * honestly returns zero threads and every "no thread carries a preview" passes vacuously.
 *
 * The child-process tests own the rest: the agent is a *process*, and its contract with the
 * install script is an exit code. Those run `server/sync.mjs --once` for real against a stub
 * that captures the request, so the assertions are transport ones — status handling, exit
 * codes, missing variables, and the shape of the body whatever the scan found.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

import { buildSnapshot, machineName } from '../server/sync.mjs'

const AGENT = fileURLToPath(new URL('../server/sync.mjs', import.meta.url))
/** The server's rule, copied from the contract rather than imported: this is the thing the
 *  two halves have to agree about, so the test should fail if either side moves alone. */
const MACHINE = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * A stub wall. Captures one request and answers with whatever status the test asked for, in
 * the shape `server/api.mjs` answers with — the failure lines quote the server's own `error`.
 */
async function withStub(status, run) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ headers: req.headers, method: req.method, url: req.url, body })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 200 ? JSON.stringify({ ok: true, threads: 0, machine: 'stub' }) : JSON.stringify({ error: 'Nope' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/api/sync`
  try {
    return await run({ url, seen })
  } finally {
    await new Promise((r) => server.close(r))
  }
}

/** `--once`, as a child, with a data directory of its own so it never reads this laptop's
 *  `colony.json`. Resolves with the exit code rather than throwing on a non-zero one. */
async function once(env) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-sync-'))
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [AGENT, '--once'],
      { env: { ...process.env, BOT_CROSSING_DATA: dir, BOT_CROSSING_MACHINE: 'test-machine', ...env }, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })
    )
  })
}

/**
 * Not the tidy fixture. This is the shape the plan says the live defect will have: a title that
 * is a pasted stack trace, a project called `unknown`, a `lastActivityAt` of 0, and a `ref` full
 * of session ids. Nothing here may be trimmed, summarised or dropped except by the allow-list.
 */
const nasty = {
  id: 'claude-code:11111111-2222-3333-4444-555555555555',
  title: `TypeError: Cannot read properties of undefined (reading 'plot')\n${'    at buildColony (/src/game/colony.js:118:22)\n'.repeat(40)}`,
  preview: 'why does this blow up when the repo has no threads',
  project: 'unknown',
  projectPath: '/Users/someone/repos/unknown',
  cwd: '/Users/someone/repos/unknown',
  worktree: 'spike',
  gitBranch: 'feat/spike',
  routine: { id: 'nightly' },
  harness: 'claude-code',
  harnessName: 'Claude Code',
  model: 'opus',
  effort: 'high',
  createdAt: 0,
  lastActivityAt: 0,
  lastFocusedAt: 0,
  hasError: true,
  starred: false,
  prState: null,
  archived: false,
  hasTranscript: true,
  sizeBytes: 2_100_000,
  source: 'cli',
  unread: true,
  running: false,
  canOpen: true,
  ref: { cliSessionId: '11111111-2222-3333-4444-555555555555', desktopSessionIds: ['aaaa-bbbb'] },
}

const DROPPED = ['preview', 'cwd', 'projectPath', 'worktree', 'gitBranch', 'routine']

test('buildSnapshot redacts every thread and stamps the push', () => {
  const before = Date.now()
  const snapshot = buildSnapshot([nasty], 'workshop-laptop')

  assert.equal(snapshot.machine, 'workshop-laptop')
  assert.ok(Number.isFinite(snapshot.scannedAt) && snapshot.scannedAt >= before)
  assert.equal(snapshot.threads.length, 1)

  const [thread] = snapshot.threads
  for (const key of DROPPED) assert.ok(!(key in thread), `${key} must not travel`)
  assert.deepEqual(thread.ref, {})
  assert.equal(thread.canOpen, false)

  // The awkward values survive exactly as they are: a 2 KB title is still the thread's title,
  // `unknown` is still a plot key, and 0 is an honest `lastActivityAt` the page has to draw.
  assert.equal(thread.title, nasty.title)
  assert.equal(thread.project, 'unknown')
  assert.equal(thread.lastActivityAt, 0)
  assert.equal(thread.sizeBytes, 2_100_000)
  assert.equal(thread.unread, true)

  // The source object is untouched — the agent holds the real thread for the next comparison.
  assert.equal(nasty.canOpen, true)
  assert.equal(nasty.preview, 'why does this blow up when the repo has no threads')
})

test('machineName squeezes a hostname into the contract alphabet', () => {
  // The shape a Mac actually hands over: a curly apostrophe, capitals, and a `.local` suffix.
  assert.equal(machineName('Someone’s-MacBook-Pro.local'), 'someone-s-macbook-pro-local')
  assert.equal(machineName('Bad Name!'), 'bad-name')
  assert.equal(machineName('workshop-laptop'), 'workshop-laptop')
  assert.equal(machineName('  --Studio--  '), 'studio')
  assert.equal(machineName('MacBook.local.'), 'macbook-local')

  // 63 characters is the filename budget, and the cut must not leave a trailing separator —
  // `…-pro-` fails the server's regex for a reason nobody typed.
  const long = machineName(`${'a'.repeat(62)}.${'b'.repeat(40)}`)
  assert.equal(long, 'a'.repeat(62), 'the cut landed on the separator, so the separator goes too')
  assert.ok(MACHINE.test(long))
  assert.equal(machineName('x'.repeat(70)), 'x'.repeat(63))

  for (const bad of ['', '!!!', '---', null]) assert.throws(() => machineName(bad), /normalises to/)
})

test('--once posts a redacted snapshot and exits 0', async () => {
  await withStub(200, async ({ url, seen }) => {
    const run = await once({ BOT_CROSSING_SYNC_URL: url, BOT_CROSSING_SYNC_TOKEN: 'test-token' })
    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stdout, /pushed \d+ threads \(\d+ running, \d+ waiting\) in \d+ms/)

    assert.equal(seen.length, 1)
    const [request] = seen
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer test-token')
    assert.equal(request.headers['content-type'], 'application/json')

    const body = JSON.parse(request.body)
    assert.ok(MACHINE.test(body.machine), `machine "${body.machine}" must match the contract`)
    assert.ok(Number.isFinite(body.scannedAt))
    assert.ok(Math.abs(Date.now() - body.scannedAt) < 60_000, 'scannedAt is this push, not a stored one')
    assert.ok(Array.isArray(body.threads))

    // Whatever this machine happened to have open. Vacuous where there is nothing to scan,
    // which is why `buildSnapshot` above is tested against a fixture as well as here.
    for (const thread of body.threads) {
      for (const key of DROPPED) assert.ok(!(key in thread), `${key} must not travel`)
      assert.deepEqual(thread.ref, {})
      assert.equal(thread.canOpen, false)
    }
  })
})

test('--once exits 1 and says what the wall said', async () => {
  await withStub(500, async ({ url, seen }) => {
    const run = await once({ BOT_CROSSING_SYNC_URL: url, BOT_CROSSING_SYNC_TOKEN: 'test-token' })
    assert.equal(run.code, 1)
    assert.match(run.stdout, /push failed: 500 Nope/)
    assert.equal(seen.length, 1, 'it still tried')
  })
})

test('a missing token stops it before it scans anything', async () => {
  const run = await once({ BOT_CROSSING_SYNC_URL: 'http://127.0.0.1:1/api/sync', BOT_CROSSING_SYNC_TOKEN: '' })
  assert.equal(run.code, 1)
  assert.match(run.stderr, /BOT_CROSSING_SYNC_TOKEN/)
  assert.doesNotMatch(run.stdout, /pushed|push failed/)
})

test('a hostname that is not a filename is normalised before it is sent', async () => {
  await withStub(200, async ({ url, seen }) => {
    const run = await once({
      BOT_CROSSING_SYNC_URL: url,
      BOT_CROSSING_SYNC_TOKEN: 'test-token',
      BOT_CROSSING_MACHINE: 'Bad Name!',
    })
    assert.equal(run.code, 0, run.stderr)
    assert.equal(JSON.parse(seen[0].body).machine, 'bad-name')
  })
})
