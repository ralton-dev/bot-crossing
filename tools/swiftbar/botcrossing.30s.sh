#!/bin/sh
#
# <xbar.title>Bot Crossing</xbar.title>
# <xbar.version>v1.0</xbar.version>
# <xbar.author>Bot Crossing</xbar.author>
# <xbar.desc>Status of the Bot Crossing display sync agent</xbar.desc>
# <xbar.dependencies>sh,launchctl</xbar.dependencies>
# <swiftbar.runInBash>false</swiftbar.runInBash>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
#
# One moon icon in the menu bar, tinted by whether the laptop is still talking to the wall.
#
# It owns nothing and starts nothing. The agent's log is already a status feed — one line every
# thirty seconds, for months — so this is a reader of that feed plus one question to launchctl,
# and everything it says is something you could have read yourself with `tail`.
#
# It never sources the env file. Sourcing it would put BOT_CROSSING_SYNC_TOKEN into the
# environment of a script that macOS re-runs every thirty seconds and whose output goes straight
# onto a screen; it greps the two keys that are not secrets instead, and knows nothing else about
# that file beyond whether it is there.
#
# Deliberately no `set -e`. A plugin that exits early prints half a menu, and half a menu looks
# exactly like a working one — every path below has to reach the printing at the bottom, even the
# ones where there is no log, no agent and nothing configured. `set -u` stays: an unset variable
# here is a typo, and a typo should be loud in the tests rather than quiet in the menu bar.
set -u

# Overridable so the tests can point the whole thing at a fixture directory. The defaults are the
# real ones and match tools/sync-install.sh line for line.
LABEL=${BOTCROSSING_LABEL:-com.botcrossing.sync}
LOG=${BOTCROSSING_LOG:-$HOME/Library/Logs/$LABEL.log}
ENV_FILE=${BOTCROSSING_ENV:-$HOME/.config/bot-crossing/sync.env}
DOMAIN="gui/$(id -u)"

# The log writes time of day only, so the clock this compares against is time of day too, and
# BOTCROSSING_NOW lets a fixture claim it is 23:23:58 without waiting until it is.
NOW=${BOTCROSSING_NOW:-$(date +%H:%M:%S)}

TINT_OK='#34c759'
TINT_STALE='#ff9f0a'
TINT_FAILING='#ff3b30'
TINT_OFF='#8e8e93'

# `|` separates a menu line from its parameters, so a `|` arriving from a log line or an error
# message would be read as markup. Nothing in the agent's own output contains one; an error from
# somewhere else might. `\r` for the same reason: it would cut the line short on screen.
clean() {
  printf '%s' "$1" | tr -d '\r' | sed 's/|/¦/g'
}

# Only ever called with BOT_CROSSING_SYNC_URL and BOT_CROSSING_MACHINE. Last assignment wins, the
# way a shell reading the file would, and surrounding quotes come off because the file is written
# by hand as often as by a script.
env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

# `08` is not a valid octal number and `$(( ))` reads a leading zero as octal, so every field
# loses its zero before it is arithmetic.
to_seconds() {
  _h=${1%%:*}
  _rest=${1#*:}
  _m=${_rest%%:*}
  _s=${_rest##*:}
  _h=${_h#0}
  _m=${_m#0}
  _s=${_s#0}
  echo $(( ${_h:-0} * 3600 + ${_m:-0} * 60 + ${_s:-0} ))
}

# How long ago an `HH:MM:SS` from the log was. A negative answer means the log line is from
# yesterday and the clock has been round midnight since, which is a wrap, not a time machine.
age_of() {
  _then=$(to_seconds "$1")
  _age=$(( $(to_seconds "$NOW") - _then ))
  [ "$_age" -lt 0 ] && _age=$(( _age + 86400 ))
  echo "$_age"
}

# Sixty lines is half an hour of ticks: far enough back to date the last successful push even
# when it is well past the six-minute heartbeat, and bounded so a log nobody has rotated since
# spring is not read end to end twice a minute.
RECENT=$(tail -n 60 "$LOG" 2>/dev/null || true)
LAST_LINE=$(printf '%s\n' "$RECENT" | grep -v '^[[:space:]]*$' | tail -1)
# stdout lines are timestamped; stderr lines — crashes, stack traces, the "not set" refusals —
# land in the same file with no prefix. Telling them apart is the whole of the failing rule.
LAST_TICK=$(printf '%s\n' "$RECENT" | grep -E '^[0-9][0-9]:[0-9][0-9]:[0-9][0-9] ' | tail -1)
LAST_PUSH=$(printf '%s\n' "$RECENT" | grep -E '^[0-9][0-9]:[0-9][0-9]:[0-9][0-9] pushed ' | tail -1)
COUNTS=$(printf '%s\n' "$RECENT" | grep -E '[0-9]+ threads \([0-9]+ running, [0-9]+ waiting\)' | tail -1)
CRASH=$(printf '%s\n' "$RECENT" | tail -5 | grep -m1 '^bot-crossing sync: ' || true)

MACHINE=$(env_value BOT_CROSSING_MACHINE)
# The agent's own default when the key is absent: this machine's short name, lowercased. Read at
# runtime, never written down here — this file is public and generic.
[ -n "$MACHINE" ] || MACHINE=$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z')
URL=$(env_value BOT_CROSSING_SYNC_URL)
# The env file holds the API endpoint the agent POSTs to. What a person wants to open is the page
# in front of it, so the path comes off and the two hrefs are built from what is left.
BASE=${URL%/api/sync}
BASE=${BASE%/}
HOST=${BASE#*://}
HOST=${HOST%%/*}

# Strict precedence, first match wins: off, then failing, then stale, then ok. A stale log on an
# agent that is not loaded is not two problems, it is one, and the first line is the one to fix.
#
# launchctl is asked only whether the label is loaded. Not for the pid, and not for `state =
# running`: KeepAlive with ThrottleInterval 30 means a process crash-looping every thirty seconds
# reports itself running for most of every second you ask. The log knows; launchctl does not.
if [ ! -f "$ENV_FILE" ]; then
  STATE=off
  SENTENCE='Not configured on this machine'
elif ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  STATE=off
  SENTENCE='Not running · the agent is not loaded'
elif [ -n "$CRASH" ]; then
  STATE=failing
  SENTENCE="Failing · ${CRASH#bot-crossing sync: }"
elif [ -n "$LAST_TICK" ] && { case ${LAST_TICK#* } in 'push failed: '*) true ;; *'backing off'*) true ;; *) false ;; esac; }; then
  STATE=failing
  MESSAGE=${LAST_TICK#* }
  SENTENCE="Failing · ${MESSAGE#push failed: }"
elif [ ! -f "$LOG" ]; then
  # A fresh install between `launchctl bootstrap` and the first tick. Amber, because green would
  # be a claim about a push that has not happened.
  STATE=stale
  SENTENCE='Stale · no log yet'
elif [ "$(( $(date +%s) - $(stat -f %m "$LOG" 2>/dev/null || echo 0) ))" -gt 120 ]; then
  # It logs every tick, even when it has nothing to send, so silence is not quiet — it is the
  # machine asleep, the process wedged, or launchd having given up between restarts.
  STATE=stale
  SENTENCE="Stale · nothing logged for $(( ( $(date +%s) - $(stat -f %m "$LOG" 2>/dev/null || echo 0) + 30 ) / 60 )) min"
elif [ -z "$LAST_PUSH" ]; then
  STATE=stale
  SENTENCE='Stale · no push yet'
elif [ "$(age_of "${LAST_PUSH%% *}")" -gt 360 ]; then
  # An unchanged colony is still re-sent every five minutes, because the wall's staleness clock
  # counts from when a push landed. Six minutes without one means a heartbeat was missed.
  STATE=stale
  SENTENCE="Stale · last push $(( ( $(age_of "${LAST_PUSH%% *}") + 30 ) / 60 )) min ago"
else
  STATE=ok
  SENTENCE=$(printf '%s\n' "$COUNTS" | sed -n \
    's/^.* \([0-9][0-9]*\) threads (\([0-9][0-9]*\) running, \([0-9][0-9]*\) waiting).*$/Pushing · \1 threads · \2 running · \3 waiting/p')
  [ -n "$SENTENCE" ] || SENTENCE='Pushing'
fi

case $STATE in
  ok) TINT=$TINT_OK ;;
  stale) TINT=$TINT_STALE ;;
  failing) TINT=$TINT_FAILING ;;
  *) TINT=$TINT_OFF ;;
esac

# The bar itself is the icon and nothing else. A count next to it would be one more number among
# twenty other menu items; the colour is the whole message and the rest is one click away.
printf '| sfimage=moon.stars.fill sfcolor=%s\n' "$TINT"
echo '---'
printf '%s | size=13\n' "$(clean "$SENTENCE")"

if [ "$STATE" = off ]; then
  # Nothing to open and nothing to restart: both would be buttons that cannot work. If this file
  # is still sitting in a checkout — SwiftBar runs it through the symlink, so one hop of readlink
  # is what gets back there — the one useful thing to say is how to turn it on.
  SELF=$0
  [ -L "$SELF" ] && SELF=$(readlink "$SELF")
  case $SELF in
    /*) ;;
    *) SELF="$(dirname "$0")/$SELF" ;;
  esac
  REPO=$(cd "$(dirname "$SELF")/../.." 2>/dev/null && pwd) || REPO=
  if [ -n "${REPO:-}" ] && [ -f "$REPO/tools/sync-install.sh" ]; then
    printf 'Install: sh tools/sync-install.sh | size=11 color=gray\n'
  fi
  exit 0
fi

# The log line verbatim, in a monospace font, because every question this menu cannot answer is
# answered by the exact text of the last tick.
[ -n "$LAST_LINE" ] && printf '%s | font=Menlo size=11 color=gray\n' "$(clean "$LAST_LINE")"
[ -n "$HOST" ] && printf 'Machine: %s → %s | size=11 color=gray\n' "$(clean "$MACHINE")" "$(clean "$HOST")"

echo '---'
if [ -n "$BASE" ]; then
  printf 'Open the wall | href=%s/?kiosk=1\n' "$BASE"
  printf 'Open the panel view | href=%s/\n' "$BASE"
fi
# Absolute paths: `bash=` is exec'd by SwiftBar, which has its own PATH and not this one.
# `refresh=true` so the icon re-reads the log as soon as the kickstart has had its moment.
printf 'Restart agent | bash=/bin/launchctl param1=kickstart param2=-k param3=%s/%s terminal=false refresh=true\n' "$DOMAIN" "$LABEL"
printf 'Tail the log | bash=/usr/bin/tail param1=-f param2=%s terminal=true\n' "$LOG"
