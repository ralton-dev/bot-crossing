/**
 * What a thread is allowed to look like once it leaves the machine that owns it.
 *
 * A local colony can say anything it likes — it is already on the machine holding the files.
 * A snapshot pushed to a wall display is not: it crosses a network, lands on a disk somebody
 * else administers, and is read by whoever can see the screen. Prompts, working directories,
 * branch names and session ids are all off-machine secrets there, and none of them draw a
 * single pixel of the colony.
 *
 * So this is an allow-list, not a delete-list. A harness adapter that grows a new field gets
 * it dropped by default rather than shipped by accident, which is the right way round.
 *
 * Applied twice on purpose: by the sync agent before sending, and by the display server on
 * ingest and again on read. The second and third are not redundant — they are what makes the
 * snapshot directory safe no matter who wrote into it.
 */

/**
 * Decision 6. `project` survives because it is the plot key and the laptop already
 * disambiguated it during the scan, so `projectPath` is not needed remotely.
 */
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
]

/**
 * Dropped fields come back *absent*, never blanked. A `preview: ''` would say the prompt made
 * the trip and was emptied at the far end; an absent key says it never travelled.
 *
 * `ref` is the exception: it is present and empty, because the page reads `thread.ref` without
 * guarding and an empty object is the honest answer — there is nothing here to open.
 */
export function redactThread(thread) {
  const src = thread && typeof thread === 'object' ? thread : {}
  const out = {}
  for (const key of KEPT) if (key in src) out[key] = src[key]
  out.canOpen = false
  out.ref = {}
  return out
}

export { KEPT as KEPT_FIELDS }
