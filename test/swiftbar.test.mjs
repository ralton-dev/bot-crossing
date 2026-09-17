/**
 * The menu bar plugin, run as the process SwiftBar runs: `sh tools/swiftbar/botcrossing.30s.sh`
 * against a fixture log, a fixture env file and a stub `launchctl` at the front of PATH.
 *
 * Written before the plugin existed. Its first run was 12 failures out of 13, every one of them
 * `tools/swiftbar/botcrossing.30s.sh` not existing — `sh` exiting 127 and printing nothing. (The
 * thirteenth, the token one, passed on an empty stdout and was worth nothing until the script
 * arrived.) That is the point: the fixtures below are the specification the script was then
 * written against, not a description of what it happened to do.
 *
 * Every test here spawns a process and most of them read a file's mtime with BSD `stat -f %m`,
 * so they are gated on darwin exactly as `test/macos.test.mjs` gates its own process tests. On
 * CI's Linux runners this whole file skips and reports green having proved nothing; the plugin
 * is macOS-only software and this is the machine it is tested on.
 *
 * Nothing here touches the real log or the real env file: the plugin reads its three paths from
 * `BOTCROSSING_LOG`, `BOTCROSSING_ENV` and `BOTCROSSING_LABEL`, and its clock from
 * `BOTCROSSING_NOW`, which exists so a fixture can say "nine minutes ago" and mean it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const PLUGIN = fileURLToPath(new URL('../tools/swiftbar/botcrossing.30s.sh', import.meta.url))
const macOnly = { skip: process.platform !== 'darwin' }

/** The tints from the contract. Named here so a test reads as a state, not as a hex code. */
const OK = '#34c759'
const STALE = '#ff9f0a'
const FAILING = '#ff3b30'
const OFF = '#8e8e93'

/** A fake token, in a fake env file. No test asserts on it except to demand its absence. */
const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'
const ENV_FILE = [
  'BOT_CROSSING_SYNC_URL=https://colony.example/api/sync',
  `BOT_CROSSING_SYNC_TOKEN=${TOKEN}`,
  'BOT_CROSSING_MACHINE=workshop-laptop',
  '',
].join('\n')

/** `HH:MM:SS`, `seconds` before `now` (itself `HH:MM:SS`), wrapping backwards past midnight. */
function before(now, seconds) {
  const [h, m, s] = now.split(':').map(Number)
  const t = (h * 3600 + m * 60 + s - seconds + 86400) % 86400
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
}

/**
 * One fixture machine: a temp directory holding the log, the env file and a stub `launchctl`
 * that exits with whatever this test wants. The stub goes at the front of PATH, so the plugin
 * finds it instead of the real one and no test can disturb the agent actually running here.
 */
async function withFixture({ log, env = ENV_FILE, launchctlExit = 0 }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-swiftbar-'))
  const bin = path.join(dir, 'bin')
  await fsp.mkdir(bin)
  await fsp.writeFile(
    path.join(bin, 'launchctl'),
    `#!/bin/sh\nif [ "\${1:-}" = "print" ]; then\n  echo "com.botcrossing.sync = {"\n  echo "  state = running"\n  echo "  pid = 4242"\n  echo "}"\nfi\nexit ${launchctlExit}\n`,
    { mode: 0o755 },
  )
  const logPath = path.join(dir, 'sync.log')
  if (log !== null) await fsp.writeFile(logPath, log)
  const envPath = path.join(dir, 'sync.env')
  if (env !== null) await fsp.writeFile(envPath, env, { mode: 0o600 })
  return { dir, bin, logPath, envPath }
}

/** Run the plugin the way SwiftBar does — `sh <file>`, no arguments — and hand back its output. */
function run(fixture, now) {
  const env = {
    PATH: `${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: fixture.dir,
    BOTCROSSING_LABEL: 'com.botcrossing.sync',
    BOTCROSSING_LOG: fixture.logPath,
    BOTCROSSING_ENV: fixture.envPath,
  }
  if (now) env.BOTCROSSING_NOW = now
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', [PLUGIN], { env, timeout: 10000 }, (err, stdout, stderr) => {
      if (err && err.code === undefined) return reject(err)
      resolve({ code: err ? err.code : 0, stdout, stderr, lines: stdout.split('\n') })
    })
  })
}

/** The bar line is the first one, and it is the icon and nothing else. */
function tint(out) {
  assert.match(out.lines[0], /^\| sfimage=moon\.stars\.fill sfcolor=#[0-9a-f]{6}$/)
  return out.lines[0].replace(/^.*sfcolor=/, '')
}

/** Every case asserts this, not just the one named for it: a leak in any state is a leak. */
function assertNoToken(out) {
  assert.equal(out.stdout.includes(TOKEN), false, 'the token value reached the menu bar')
  assert.equal(out.stdout.includes('SYNC_TOKEN'), false, 'the token key reached the menu bar')
}

/** A log the way launchd has it: one line per tick, newest last, `HH:MM:SS` prefixed. */
function healthyLog(now) {
  return [
    `${before(now, 150)} pushed 584 threads (1 running, 1 waiting) in 322ms`,
    `${before(now, 120)} unchanged — 584 threads (1 running, 1 waiting), last push 30s ago`,
    `${before(now, 90)} unchanged — 584 threads (1 running, 1 waiting), last push 60s ago`,
    `${before(now, 60)} unchanged — 584 threads (1 running, 1 waiting), last push 90s ago`,
    `${before(now, 30)} pushed 584 threads (0 running, 2 waiting) in 289ms`,
    '',
  ].join('\n')
}

test('a healthy log is green, and the dropdown carries the counts, the last line and the wall', macOnly, async () => {
  const now = '23:23:58'
  const out = await run(await withFixture({ log: healthyLog(now) }), now)
  assert.equal(tint(out), OK)
  assert.equal(out.lines[1], '---')
  assert.match(out.stdout, /^Pushing · 584 threads · 0 running · 2 waiting \| size=13$/m)
  assert.match(out.stdout, /^23:23:28 pushed 584 threads \(0 running, 2 waiting\) in 289ms \| font=Menlo/m)
  assert.match(out.stdout, /^Machine: workshop-laptop → colony\.example \| /m)
  assertNoToken(out)
})

test('the action items are the wall, the panel, a restart and a tail — and the hrefs drop /api/sync', macOnly, async () => {
  const now = '23:23:58'
  const fixture = await withFixture({ log: healthyLog(now) })
  const out = await run(fixture, now)
  assert.match(out.stdout, /^Open the wall \| href=https:\/\/colony\.example\/\?kiosk=1$/m)
  assert.match(out.stdout, /^Open the panel view \| href=https:\/\/colony\.example\/$/m)
  assert.equal(out.stdout.includes('/api/sync'), false, 'the API endpoint is not a page to open')
  assert.match(out.stdout, /^Restart agent \| bash=\/bin\/launchctl param1=kickstart param2=-k param3=gui\/\d+\/com\.botcrossing\.sync terminal=false refresh=true$/m)
  assert.match(out.stdout, new RegExp(`^Tail the log \\| bash=/usr/bin/tail param1=-f param2=${fixture.logPath} terminal=true$`, 'm'))
  assertNoToken(out)
})

test('a push that failed is red, and says what failed', macOnly, async () => {
  const now = '23:23:58'
  const log = [
    `${before(now, 60)} pushed 584 threads (1 running, 1 waiting) in 322ms`,
    `${before(now, 30)} push failed: fetch failed (ECONNREFUSED)`,
    '',
  ].join('\n')
  const out = await run(await withFixture({ log }), now)
  assert.equal(tint(out), FAILING)
  assert.match(out.stdout, /^Failing · fetch failed \(ECONNREFUSED\) \| size=13$/m)
  assertNoToken(out)
})

test('backing off is red even though the newest line is not the failure itself', macOnly, async () => {
  const now = '23:23:58'
  const log = [
    `${before(now, 60)} push failed: fetch failed (ECONNREFUSED)`,
    `${before(now, 30)} 5 failures in a row — backing off to 300s`,
    '',
  ].join('\n')
  const out = await run(await withFixture({ log }), now)
  assert.equal(tint(out), FAILING)
  assert.match(out.stdout, /^Failing · 5 failures in a row — backing off to 300s \| size=13$/m)
  assertNoToken(out)
})

test('an untimestamped stderr line in the last few is red — that is a crash, not a tick', macOnly, async () => {
  const now = '23:23:58'
  const log = [
    `${before(now, 90)} pushed 584 threads (1 running, 1 waiting) in 322ms`,
    `${before(now, 60)} pushed 584 threads (1 running, 1 waiting) in 301ms`,
    'bot-crossing sync: BOT_CROSSING_SYNC_URL not set — nothing to push to',
    '',
  ].join('\n')
  const out = await run(await withFixture({ log }), now)
  assert.equal(tint(out), FAILING)
  assert.match(out.stdout, /^Failing · BOT_CROSSING_SYNC_URL not set — nothing to push to \| size=13$/m)
  assertNoToken(out)
})

test('a heartbeat missed is amber: the agent is up and logging, but nothing has landed', macOnly, async () => {
  const now = '23:23:58'
  const lines = [`${before(now, 540)} pushed 584 threads (1 running, 1 waiting) in 322ms`]
  for (let ago = 510; ago >= 30; ago -= 30) {
    lines.push(`${before(now, ago)} unchanged — 584 threads (1 running, 1 waiting), last push ${540 - ago}s ago`)
  }
  const out = await run(await withFixture({ log: `${lines.join('\n')}\n` }), now)
  assert.equal(tint(out), STALE)
  assert.match(out.stdout, /^Stale · last push 9 min ago \| size=13$/m)
  assertNoToken(out)
})

test('a label launchctl does not know is grey, with nothing to click', macOnly, async () => {
  const now = '23:23:58'
  const out = await run(await withFixture({ log: healthyLog(now), launchctlExit: 1 }), now)
  assert.equal(tint(out), OFF)
  assert.match(out.stdout, /^Not running · the agent is not loaded \| size=13$/m)
  assert.equal(out.stdout.includes('Restart agent'), false, 'an unloaded agent has nothing to restart')
  assert.equal(out.stdout.includes('href='), false, 'without the env file there is no wall to open')
  assertNoToken(out)
})

test('no env file is grey and says so — this machine was never set up', macOnly, async () => {
  const now = '23:23:58'
  const out = await run(await withFixture({ log: healthyLog(now), env: null }), now)
  assert.equal(tint(out), OFF)
  assert.match(out.stdout, /^Not configured on this machine \| size=13$/m)
  assert.match(out.stdout, /^Install: sh tools\/sync-install\.sh \| /m)
  assert.equal(out.stdout.includes('Restart agent'), false)
})

test('midnight is not a nine-hour outage: 23:59:30 seen at 00:02:00 is still green', macOnly, async () => {
  const now = '00:02:00'
  const log = [
    '23:58:30 pushed 584 threads (1 running, 1 waiting) in 322ms',
    '23:59:30 pushed 584 threads (0 running, 1 waiting) in 288ms',
    '00:00:00 unchanged — 584 threads (0 running, 1 waiting), last push 30s ago',
    '00:01:30 unchanged — 584 threads (0 running, 1 waiting), last push 120s ago',
    '',
  ].join('\n')
  const out = await run(await withFixture({ log }), now)
  assert.equal(tint(out), OK)
  assert.match(out.stdout, /^Pushing · 584 threads · 0 running · 1 waiting \| size=13$/m)
  assertNoToken(out)
})

test('a log cut off mid-line still produces a state, not an empty menu', macOnly, async () => {
  const now = '23:23:58'
  const log = `${healthyLog(now)}${before(now, 0)} unchan`
  const out = await run(await withFixture({ log }), now)
  assert.equal(tint(out), OK)
  assert.match(out.stdout, /^Pushing · 584 threads · 0 running · 2 waiting \| size=13$/m)
  assertNoToken(out)
})

test('no log at all is amber, not a crash: the first tick has not happened yet', macOnly, async () => {
  const now = '23:23:58'
  const out = await run(await withFixture({ log: null }), now)
  assert.equal(tint(out), STALE)
  assert.match(out.stdout, /^Stale · no log yet \| size=13$/m)
  assert.equal(out.lines[1], '---')
  assertNoToken(out)
})

test('the token in the env file never reaches the menu bar, in any state', macOnly, async () => {
  const now = '23:23:58'
  for (const [log, launchctlExit] of [
    [healthyLog(now), 0],
    [`${before(now, 30)} push failed: 401 Bad token\n`, 0],
    [healthyLog(now), 1],
    [null, 0],
  ]) {
    assertNoToken(await run(await withFixture({ log, launchctlExit }), now))
  }
})

test('the plugin is a single self-contained sh file, executable, that sources nothing', macOnly, () => {
  const src = fs.readFileSync(PLUGIN, 'utf8')
  assert.match(src, /^#!\/bin\/sh\n/)
  assert.equal((fs.statSync(PLUGIN).mode & 0o777).toString(8), '755')
  // Sourcing the env file would put the token into the plugin's own environment, where any
  // `set -x`, any crash dump and any child process would carry it. It greps two keys instead.
  assert.equal(/(^|\s)(source|eval)\s/m.test(src), false, 'the plugin sources or evals something')
  assert.equal(/^\s*\.\s+["'$]/m.test(src), false, 'the plugin dot-sources something')
})
