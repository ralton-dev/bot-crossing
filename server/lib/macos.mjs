/**
 * macOS desktop plumbing: hand a URL to whatever claims its scheme, and put a command in a
 * terminal window when nothing does.
 *
 * The Linux half of this lives in `xdg.mjs`; this is the same shape for a Mac. Only
 * `server/api.mjs` uses it, and nothing in here knows about a particular harness — an adapter
 * hands the server an argv, the server decides whether a terminal is the right place for it.
 *
 * Why it exists: `open(1)` is what answers a `harness://` deep link, and it can only do so when
 * an app has registered the scheme. The Claude desktop app registers `claude://`; the CLI on its
 * own does not (it registers `claude-cli://`, for its own login callback). A Mac with just the CLI
 * therefore gets `kLSApplicationNotFoundErr` from `open`, which used to be fired detached and
 * ignored — the page said "Opened" and nothing happened. Now the exit code is read, and a refusal
 * falls through to the harness's own CLI in a Terminal.app window, as Linux already did.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Hand a URL to Launch Services and say whether anything took it. `open` exits 0 the moment the
 * handler is found — it does not wait for the app — and exits 1 with
 * `kLSApplicationNotFoundErr` when no app claims the scheme, which is the one case worth
 * telling apart.
 */
export async function openUrl(url) {
  try {
    await execFileAsync('open', [url], { timeout: 5000 })
    return { ok: true }
  } catch (err) {
    const text = String(err?.stderr || err?.message || err)
    if (/kLSApplicationNotFoundErr|No application knows how to open/i.test(text)) {
      return { ok: false, error: 'no handler' }
    }
    return { ok: false, error: text.trim() }
  }
}

/** POSIX single-quote: the only shell quoting that never needs a second rule. */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * The one line the terminal will be told to run. `exec` so the shell Terminal started gives its
 * process to the CLI rather than sitting behind it, and `cd` first because `claude --resume`
 * looks the session up under the folder it ran in.
 */
export function shellLine(argv, cwd) {
  return `cd ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(' ')}`
}

/**
 * Terminal.app has no command line of its own that takes a directory and a command, so it is
 * driven through AppleScript. The line arrives as an AppleScript *argument* rather than being
 * spliced into the script, so nothing in it is ever read as AppleScript. Nothing is read from or
 * executed inside the app's bundle: `osascript` is a system tool, and the OS does the rest.
 */
const SCRIPT = ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run']

/**
 * Run `argv` in a new Terminal.app window with `cwd` as its working directory. The caller has
 * already resolved both: `argv[0]` is an absolute executable and `cwd` an existing directory.
 */
export async function openInTerminal(argv, cwd) {
  const wellFormed = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string' && a)
  if (!wellFormed || !path.isAbsolute(argv[0]) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, error: 'Invalid launch command' }
  }
  const args = SCRIPT.flatMap((line) => ['-e', line])
  try {
    await execFileAsync('osascript', [...args, shellLine(argv, cwd)], { timeout: 15000 })
    return { ok: true, terminal: 'terminal' }
  } catch (err) {
    const text = String(err?.stderr || err?.message || err).trim()
    return { ok: false, error: `Could not open Terminal.app (${text})` }
  }
}
