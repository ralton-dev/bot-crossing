/**
 * Kiosk mode: the same colony, on a wall, with nobody standing in front of it.
 *
 * It is a *page* concern, not a server one — a display-mode server still serves an ordinary
 * interactive page, and a laptop dev server can be put in kiosk mode to see what the wall
 * will look like without a cluster in the way. So it is selected by the URL and nothing else.
 */

/** `?kiosk=1` or `?kiosk=true`. Anything else, including no query at all, is the normal page. */
export function parseKiosk(search) {
  const value = new URLSearchParams(search || '').get('kiosk')
  return value === '1' || value === 'true'
}

/**
 * What a screen nobody touches wants. Auto-framing and follow both exist to put the view back
 * where a *hand* left it, and there is no hand; dormant repos are years of checkouts nobody
 * is going to walk over and dismiss; the labels are the only thing that makes the colony
 * readable from across a room; and a frame counter is not decoration.
 *
 * Applied without persisting (`settings.applyAll(…, { persist: false })`) — the wall's browser
 * must not come to believe this is what its owner chose.
 */
export const KIOSK_SETTINGS = {
  autoFrame: false,
  followSelected: false,
  hideDormant: true,
  showLabels: true,
  showFps: false,
}
