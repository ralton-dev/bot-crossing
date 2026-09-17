/**
 * The macOS launcher: the shell line it hands Terminal.app, and what it refuses. Nothing here
 * opens a window, so it says the same thing on any machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { openInTerminal, shellLine, shellQuote } from '../server/lib/macos.mjs'

test('shellQuote survives the characters a repo path or title can carry', () => {
  assert.equal(shellQuote('plain'), `'plain'`)
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('$HOME `x` "y" ; rm -rf /'), `'$HOME \`x\` "y" ; rm -rf /'`)
})

test('shellLine cds first and execs the argv, every word quoted', () => {
  const line = shellLine(['/Users/me/.local/bin/claude', '--resume', 'abc'], "/Users/me/repos/it's here")
  assert.equal(line, `cd '/Users/me/repos/it'\\''s here' && exec '/Users/me/.local/bin/claude' '--resume' 'abc'`)
})

test('openInTerminal refuses a malformed command before touching the desktop', async () => {
  for (const [argv, cwd] of [
    [[], '/tmp'],
    [['claude'], '/tmp'],
    [['/usr/bin/true'], 'relative'],
    [['/usr/bin/true', ''], '/tmp'],
    ['not-an-array', '/tmp'],
  ]) {
    const r = await openInTerminal(argv, cwd)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'Invalid launch command')
  }
})
