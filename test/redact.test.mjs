/**
 * Redaction, on its own, against a thread with every field a real Claude Code scan produces.
 *
 * The display server redacts on ingest and again on read, and the sync agent redacts before it
 * sends — three call sites, one function, and the only place the rule itself is checked. The
 * assertion that matters is the exact key set: a field nobody listed must not travel, and the
 * failure mode of a delete-list is that a harness grows a field and ships it silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { redactThread } from '../server/lib/redact.mjs'

/**
 * `toThread` in server/harnesses/claude-code.mjs, plus the `harness`/`harnessName` that
 * server/scan.mjs:78 stamps on afterwards. Every value is non-empty on purpose: a field that is
 * `''` in the fixture would let a dropped key pass for the wrong reason.
 */
const scanned = {
  id: 'claude-code:11111111-2222-3333-4444-555555555555',
  cliSessionId: '11111111-2222-3333-4444-555555555555',
  desktopSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  desktopSessionIds: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
  titled: true,
  bridgeSessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  title: 'Wire the hex plot labels',
  preview: 'the labels on the plots drift when the camera orbits, can you pin them to the plot',
  project: 'bot-crossing',
  projectPath: '/Users/someone/repos/bot-crossing',
  worktree: 'labels',
  cwd: '/Users/someone/repos/bot-crossing/../bot-crossing',
  gitBranch: 'feat/labels',
  model: 'opus',
  effort: 'high',
  createdAt: 1758000000000,
  lastActivityAt: 1758123456789,
  recordActivityAt: 1758123000000,
  lastFocusedAt: 1758123000000,
  hasLiveProcess: true,
  hasError: false,
  starred: true,
  routine: 'scheduled-task-7',
  prState: 'open',
  archived: false,
  hasTranscript: true,
  sizeBytes: 481203,
  source: 'desktop',
  unread: true,
  running: true,
  canOpen: true,
  ref: {
    desktopSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    desktopSessionIds: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    cliSessionId: '11111111-2222-3333-4444-555555555555',
    cwd: '/Users/someone/repos/bot-crossing',
  },
  harness: 'claude-code',
  harnessName: 'Claude Code',
}

const KEPT = [
  'id',
  'title',
  'project',
  'harness',
  'harnessName',
  'model',
  'effort',
  'createdAt',
  'lastActivityAt',
  'lastFocusedAt',
  'hasError',
  'starred',
  'prState',
  'archived',
  'hasTranscript',
  'sizeBytes',
  'source',
  'unread',
  'running',
  'canOpen',
  'ref',
]

test('a redacted thread carries exactly the fields decision 6 allows', () => {
  const out = redactThread(scanned)
  assert.deepEqual(Object.keys(out).sort(), [...KEPT].sort())
  for (const key of KEPT) {
    if (key === 'canOpen' || key === 'ref') continue
    assert.deepEqual(out[key], scanned[key], `${key} came through changed`)
  }
})

test('nothing that names a prompt, a path or a session id survives', () => {
  const out = redactThread(scanned)
  // Absent, not blank. `preview: ''` would mean the prompt made the trip and was emptied at the
  // far end; the point is that it never left the machine that owns it.
  for (const key of ['preview', 'cwd', 'projectPath', 'worktree', 'gitBranch', 'routine']) {
    assert.ok(!(key in out), `${key} is still on the thread`)
  }
  for (const key of ['cliSessionId', 'desktopSessionId', 'desktopSessionIds', 'bridgeSessionId']) {
    assert.ok(!(key in out), `${key} is still on the thread`)
  }
  assert.deepEqual(out.ref, {}, 'ref is present and empty, so the page can read it without guarding')
})

test('canOpen is false however keenly the scan said otherwise', () => {
  assert.equal(redactThread(scanned).canOpen, false)
  assert.equal(redactThread({ ...scanned, canOpen: true }).canOpen, false)
})

test('a thread missing a field does not gain it as undefined', () => {
  const out = redactThread({ id: 'codex:x', title: 'Thin', lastActivityAt: 7 })
  assert.deepEqual(Object.keys(out).sort(), ['canOpen', 'id', 'lastActivityAt', 'ref', 'title'])
})

test('redaction copies rather than edits — the sync agent still has its own list to log', () => {
  const before = JSON.stringify(scanned)
  redactThread(scanned)
  assert.equal(JSON.stringify(scanned), before)
})

test('rubbish in is an empty thread, not a throw', () => {
  // `readSnapshots` maps this over whatever is on disk, and a hand-edited snapshot must not
  // take the colony down.
  assert.deepEqual(redactThread(null), { canOpen: false, ref: {} })
  assert.deepEqual(redactThread('nope'), { canOpen: false, ref: {} })
})
