import test from 'node:test'
import assert from 'node:assert/strict'
import { KIOSK_SETTINGS, parseKiosk } from '../src/game/kiosk.js'
import { Settings } from '../src/core/settings.js'

// There is no DOM in this suite, so the wall display is tested where it is decidable: the
// two pure things kiosk mode is made of. Everything else about it — the hidden chrome, the
// unbound listeners, the sweep — is a browser fact and is checked in a browser.
//
// `Settings` imports and constructs here without a DOM: its only two touches of
// `localStorage` are both inside a `try`, and a missing global throws a ReferenceError that
// the same `catch` swallows. So its real defaults are available to assert against.

test('parseKiosk only says yes when the URL asks for it', () => {
  assert.equal(parseKiosk('?kiosk=1'), true)
  assert.equal(parseKiosk('?kiosk=true'), true)
  assert.equal(parseKiosk('?kiosk=0'), false)
  assert.equal(parseKiosk('?kiosk=false'), false)
  // A bare `?kiosk` is an empty value, not a yes: a wall is a deliberate thing to ask for.
  assert.equal(parseKiosk('?kiosk'), false)
  assert.equal(parseKiosk(''), false)
  assert.equal(parseKiosk(undefined), false)
  assert.equal(parseKiosk('?planet=moon'), false)
  // It is one parameter among others, wherever it lands in the query.
  assert.equal(parseKiosk('?planet=moon&kiosk=1'), true)
  assert.equal(parseKiosk('?kiosk=1&planet=moon'), true)
})

test('every key in the kiosk profile is a setting that exists', () => {
  const defaults = new Settings().values
  for (const [key, value] of Object.entries(KIOSK_SETTINGS)) {
    assert.ok(key in defaults, `${key} is not a setting`)
    assert.equal(typeof value, typeof defaults[key], `${key} is the wrong type for a setting`)
  }
})

test('the kiosk profile is what a screen nobody touches wants', () => {
  assert.deepEqual(KIOSK_SETTINGS, {
    autoFrame: false,
    followSelected: false,
    hideDormant: true,
    showLabels: true,
    showFps: false,
  })
})

test('applying the kiosk profile without persisting still applies it', () => {
  const settings = new Settings()
  // Opinions the wall contradicts, so applying the profile is a change rather than a no-op.
  settings.values.autoFrame = true
  settings.values.showFps = true
  let saves = 0
  settings._scheduleSave = () => saves++

  const changed = settings.applyAll(KIOSK_SETTINGS, { persist: false })
  assert.equal(changed, 2)
  assert.equal(settings.get('autoFrame'), false)
  assert.equal(settings.get('showFps'), false)
  // The whole point: the browser behind the screen does not come away believing this is
  // what its owner chose.
  assert.equal(saves, 0)

  // And the ordinary path still writes, so nothing else that adopts a saved set is affected.
  settings.values.autoFrame = true
  assert.equal(settings.applyAll(KIOSK_SETTINGS), 1)
  assert.equal(saves, 1)
})
