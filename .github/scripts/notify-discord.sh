#!/usr/bin/env bash
# Posts a deployment message to Discord. Kept out of the workflow so the wording
# lives in one place and can be read without untangling YAML.
#
#   notify-discord.sh <state> <version> <previous> <actor> <health> [seconds]
#
# state: starting | success | failure | cancelled
# Silent when DISCORD_WEBHOOK is unset, so a fork without the secret still runs.
set -euo pipefail

state="${1:?state}"
version="${2:?version}"
previous="${3:-unknown}"
actor="${4:-unknown}"
health="${5:-}"
seconds="${6:-}"
site="https://${DEPLOY_SITE:-draw.devopsproject.dev}"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

[ -n "${DISCORD_WEBHOOK:-}" ] || { echo "no webhook configured; not notifying"; exit 0; }

# ok=true/false comes from the workflow step; an empty value means the deploy
# fell over before the check ever ran.
case "${health}" in
  true) health_word="✅ passed" ;;
  false) health_word="❌ failed" ;;
  *) health_word="⚠️ never ran" ;;
esac

# "1m 46s", or empty when the caller did not time it.
took=""
if [ -n "$seconds" ] && [ "$seconds" -gt 0 ] 2>/dev/null; then
  if [ "$seconds" -ge 60 ]; then
    took="$((seconds / 60))m $((seconds % 60))s"
  else
    took="${seconds}s"
  fi
fi

# One line picked per deploy, so the channel does not read like a cron job.
pick() { printf '%s' "${@:$((RANDOM % $# + 1)):1}"; }

# A field is dropped by jq when its value is empty, so optional ones can simply
# be left unset rather than guarded at every call site.
fields='[]'
field() {
  [ -n "$2" ] || return 0
  fields=$(jq -c --arg n "$1" --arg v "$2" --argjson i "${3:-true}" \
    '. + [{name: $n, value: $v, inline: $i}]' <<<"$fields")
}

case "$state" in
  starting)
    title="🚀 ${version} is on its way to production"
    colour=5793266   # blurple
    body=$(pick \
      "_Engines lit. Hold on to something._" \
      "_Here we go. Nobody touch anything._" \
      "_Shipping it. Kettle on._")
    field "📦 Version" "\`${previous}\` ➜ \`${version}\`" false
    field "🧑‍🚀 Pilot" "${actor}"
    ;;
  success)
    title="🎉 ${version} has landed"
    colour=3066993   # green
    body=$(pick \
      "_Nothing broke. Today is a good day._" \
      "_Smooth as anything. Go look at it._" \
      "_Live and answering. Take the win._")
    field "🩺 Health check" "${health_word}"
    field "⏱️ Took" "${took}"
    field "🧑‍🚀 Pilot" "${actor}"
    field "🖼️ Have a look" "${site}" false
    field "↩️ Changed your mind?" "Run **Deploy** with \`${previous}\`" false
    ;;
  failure)
    title="🚨 ${version} did not make it"
    colour=15158332  # red
    body=$(pick \
      "_Deep breath. Read the log, fix it, ship again._" \
      "_It happens. The site is fine, the release is not._" \
      "_Caught before anyone noticed. That is the point._")
    field "🩺 Health check" "${health_word}"
    field "⏪ Put back" "\`${previous}\` — the site is still up"
    field "🔎 Evidence" "[the failing run](${run_url})" false
    ;;
  cancelled)
    title="🛑 ${version} deploy was called off"
    colour=10070709  # grey
    body="_Nothing was changed._"
    field "🧍 Stopped by" "${actor}"
    field "📦 Still running" "\`${previous}\`"
    ;;
  *)
    title="ℹ️ ${version} deploy: ${state}"
    colour=10070709  # grey
    body=""
    field "📦 From" "\`${previous}\`"
    field "🧑‍🚀 By" "${actor}"
    ;;
esac

# jq builds the JSON so a quote or newline in any value cannot break the payload.
payload=$(jq -n \
  --arg title "$title" \
  --arg body "$body" \
  --arg footer "${GITHUB_REPOSITORY:-}" \
  --arg url "$site" \
  --arg stamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson colour "$colour" \
  --argjson fields "$fields" \
  '{embeds: [{
     title: $title,
     description: $body,
     color: $colour,
     url: $url,
     timestamp: $stamp,
     fields: $fields,
     footer: {text: $footer}
   }]}')

# Discord being unreachable must not abort the deploy, so the failure is
# swallowed here and reported below rather than tripping set -e.
code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "$payload" "$DISCORD_WEBHOOK" 2>/dev/null || true)
code=${code:-000}

# A failed notification must not fail the deploy, but it must be visible.
if [ "$code" != "204" ] && [ "$code" != "200" ]; then
  echo "warning: Discord returned $code; the deploy itself is unaffected" >&2
fi
