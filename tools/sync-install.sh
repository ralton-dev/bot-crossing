#!/bin/sh
#
# Install (or remove) the launchd agent that pushes this machine's colony to a wall display.
#
# Contains no secret and never prints one. The token lives in ~/.config/bot-crossing/sync.env
# at mode 600; this script only checks that the file is there and locked down, sources it for
# the one rehearsal push below, and writes a plist that sources it again at launch.
#
#   sh tools/sync-install.sh              install and start it
#   sh tools/sync-install.sh --uninstall  stop it and remove the plist
#
set -eu

LABEL=com.botcrossing.sync
ENV_FILE="$HOME/.config/bot-crossing/sync.env"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$LABEL.log"
# The repo is wherever this script is, not wherever it was run from: the plist needs an
# absolute WorkingDirectory and `pwd` is whatever shell happened to invoke it.
REPO=$(cd "$(dirname "$0")/.." && pwd)
DOMAIN="gui/$(id -u)"
TEMPLATE="$REPO/tools/launchd/$LABEL.plist"
PLUGIN="$REPO/tools/swiftbar/botcrossing.30s.sh"
# The menu bar icon is optional and most machines will not have SwiftBar at all. `defaults read`
# on a domain that does not exist exits 1 and writes to stderr, and this script runs under
# `set -eu` — so the failure is swallowed here rather than killing an install that has already
# done its real work. An empty PLUGIN_DIR simply means there is nothing to link.
PLUGIN_DIR=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)
PLUGIN_LINK=${PLUGIN_DIR:+$PLUGIN_DIR/botcrossing.30s.sh}

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  if [ -n "$PLUGIN_LINK" ] && [ -L "$PLUGIN_LINK" ]; then
    rm -f "$PLUGIN_LINK"
    echo "removed $PLUGIN_LINK — the menu bar icon goes with the agent"
  fi
  echo "removed $PLIST — the log and $ENV_FILE are left alone"
  exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "no $ENV_FILE" >&2
  echo "It holds BOT_CROSSING_SYNC_URL and BOT_CROSSING_SYNC_TOKEN and nothing else is allowed" >&2
  echo "to know them: run the token script from the deployment plan, which writes this file at" >&2
  echo "mode 600 and seals the same token into the cluster. Nothing here can generate it." >&2
  exit 1
fi

# `stat -f %Lp` is the BSD/macOS spelling, and this is a macOS-only installer. Anything a group
# or the world can read is not a secret, and refusing is cheaper than finding out later.
MODE=$(stat -f '%Lp' "$ENV_FILE")
if [ "$MODE" != "600" ]; then
  echo "$ENV_FILE is mode $MODE, not 600 — a push token any other process can read is not one" >&2
  echo "Fix with: chmod 600 \"$ENV_FILE\"" >&2
  exit 1
fi

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "no node on PATH — launchd gets an absolute path to it and there is none to give" >&2
  exit 1
fi

# The rehearsal, before anything is installed. A wrong URL or a rotated token fails here, in
# front of you, instead of as a line in a log file that a KeepAlive job rewrites every 30s.
echo "==> rehearsing one push with $ENV_FILE"
(
  set -a
  . "$ENV_FILE"
  set +a
  cd "$REPO"
  exec "$NODE" server/sync.mjs --once
)

echo "==> writing $PLIST"
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
# `|` as the delimiter: every substitution is an absolute path and one of them is $HOME.
sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" -e "s|__HOME__|$HOME|g" "$TEMPLATE" > "$PLIST"

# bootout first so this is idempotent: bootstrap onto a label already loaded is an error, and
# the failure when nothing is loaded is the normal first-install case.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

# The menu bar icon, if there is anywhere to put it. No SwiftBar, or a SwiftBar that has never
# been told where its plugins live, means no link and no line about one — the agent is installed
# either way and an optional nicety is not worth a warning.
if [ -n "$PLUGIN_LINK" ] && [ -d "$PLUGIN_DIR" ]; then
  echo "==> linking $PLUGIN_LINK"
  ln -sfn "$PLUGIN" "$PLUGIN_LINK"
  # Ask SwiftBar to pick it up now instead of at its next scan. This fails when SwiftBar is
  # installed but not running, which is not a reason to fail an install.
  open -g 'swiftbar://refreshplugin?name=botcrossing' 2>/dev/null || true
fi

# Give it long enough to have scanned and pushed once before we show anything.
sleep 5
echo "==> launchctl print $DOMAIN/$LABEL"
launchctl print "$DOMAIN/$LABEL" | grep -E 'state|pid' || true
echo "==> tail -5 $LOG"
tail -5 "$LOG" 2>/dev/null || echo "(no log yet)"
echo
echo "It is running. Stop it with: sh tools/sync-install.sh --uninstall"
