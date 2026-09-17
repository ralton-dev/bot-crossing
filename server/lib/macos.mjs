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
 * falls through to the harness's own CLI in a terminal, as Linux already did. Which terminal is
 * `BOT_CROSSING_TERMINAL`'s to say; Terminal.app otherwise.
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { findExecutable } from './fsutil.mjs'
import { TERMINALS as CLI_FLAGS } from './terminals.mjs'
import { trySpawn } from './xdg.mjs'

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
 * The one line a terminal will be told to run. `exec` so the shell that iTerm started gives its
 * process to the CLI rather than sitting behind it, and `cd` first because `claude --resume`
 * looks the session up under the folder it ran in.
 */
export function shellLine(argv, cwd) {
  return `cd ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(' ')}`
}

const home = os.homedir()
/** An app bundle lives in one of two places; both are checked for every entry below. */
const bundle = (name) => [path.join('/Applications', name), path.join(home, 'Applications', name)]

/**
 * Terminals driven through AppleScript, because they have no command line of their own that
 * takes a working directory and a command. The line arrives as an AppleScript argument rather
 * than being spliced into the script, so nothing in it is ever read as AppleScript.
 */
const APPS = {
  terminal: {
    bundles: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'],
    script: ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run'],
  },
  iterm2: {
    bundles: bundle('iTerm.app'),
    script: [
      'on run argv',
      'tell application "iTerm2"',
      'activate',
      'set w to (create window with default profile)',
      'tell current session of w to write text (item 1 of argv)',
      'end tell',
      'end run',
    ],
  },
}

/**
 * Terminals driven through their own command line, with the flags in `terminals.mjs`. Found on
 * PATH and nowhere else: each of these keeps a real binary inside its app bundle, and running it
 * from there is exactly what DECISIONS.md forbids — a revoked signing certificate once had macOS
 * bin the app for it. Every one of them offers a PATH shim or a Homebrew install instead.
 */
const CLIS = ['kitty', 'alacritty', 'ghostty', 'wezterm']

/** The names `BOT_CROSSING_TERMINAL` accepts. */
export const KNOWN = [...Object.keys(APPS), ...CLIS]
const DEFAULT = 'terminal'

const isDir = (p) => fsp.stat(p).then((s) => s.isDirectory(), () => false)

async function firstExisting(paths, check) {
  for (const p of paths) if (await check(p)) return p
  return ''
}

/**
 * Which terminal to use, from `BOT_CROSSING_TERMINAL`, or Terminal.app when it is unset: macOS
 * has no "default terminal" setting to read, and Terminal.app is always there. A name the table
 * does not know, or one that names a terminal that is not installed, is an error rather than a
 * silent fall back — a setting that is quietly ignored is worse than one that says so.
 *
 * Returns `{ name, kind, bin }` — `kind` is `app` (AppleScript) or `cli` (its own flags), and
 * `bin` is the executable for a `cli` — or `{ error }`.
 */
export async function pickTerminal(env = process.env) {
  const name = (env.BOT_CROSSING_TERMINAL || DEFAULT).trim().toLowerCase()
  if (APPS[name]) {
    if (!(await firstExisting(APPS[name].bundles, isDir))) return { error: `${name} is not installed` }
    return { name, kind: 'app' }
  }
  if (CLIS.includes(name)) {
    const bin = await findExecutable(name)
    if (!bin) return { error: `${name} is not on PATH` }
    return { name, kind: 'cli', bin }
  }
  return { error: `BOT_CROSSING_TERMINAL=${name} is not a terminal this knows — one of ${KNOWN.join(', ')}` }
}

/**
 * Run `argv` in a new terminal window with `cwd` as its working directory. The caller has
 * already resolved both: `argv[0]` is an absolute executable and `cwd` an existing directory.
 */
export async function openInTerminal(argv, cwd) {
  const wellFormed = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string' && a)
  if (!wellFormed || !path.isAbsolute(argv[0]) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, error: 'Invalid launch command' }
  }
  const picked = await pickTerminal()
  if (picked.error) return { ok: false, error: picked.error }
  const { name, kind, bin } = picked

  if (kind === 'cli') {
    const result = await trySpawn(bin, CLI_FLAGS[name](cwd, argv), cwd)
    return result.ok ? { ok: true, terminal: name } : { ok: false, error: `Could not open ${name} (${result.error})` }
  }
  const args = APPS[name].script.flatMap((line) => ['-e', line])
  try {
    await execFileAsync('osascript', [...args, shellLine(argv, cwd)], { timeout: 15000 })
    return { ok: true, terminal: name }
  } catch (err) {
    const text = String(err?.stderr || err?.message || err).trim()
    return { ok: false, error: `Could not open ${name} (${text})` }
  }
}
