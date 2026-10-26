#!/usr/bin/env bash
# Posts a deployment message to Discord. Kept out of the workflow so the wording
# lives in one place and can be read without untangling YAML.
#
#   notify-discord.sh <state> <version> <previous> <actor> <health>
#
# state: starting | success | failure | cancelled
# Silent when DISCORD_WEBHOOK is unset, so a fork without the secret still runs.
set -euo pipefail

state="${1:?state}"
version="${2:?version}"
previous="${3:-unknown}"
actor="${4:-unknown}"
health="${5:-}"
site="https://${DEPLOY_SITE:-draw.devopsproject.dev}"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

[ -n "${DISCORD_WEBHOOK:-}" ] || { echo "no webhook configured; not notifying"; exit 0; }

# Real newlines, not \n: jq --arg passes the string through untouched, so an
# escape written here would show up as the characters \n in the message.
# ok=true/false comes from the workflow step; an empty value means the deploy
# fell over before the check ever ran.
case "${health}" in
  true) health_word="passed" ;;
  false) health_word="failed" ;;
  *) health_word="never ran" ;;
esac

case "$state" in
  starting)
    title="🚀 Blast off — ${version} is on its way to production"
    colour=5793266   # blurple
    body=$(printf '%s\n%s\n\n%s' \
      "📦 **${previous}** ➜ **${version}**" \
      "🧑‍🚀 Pilot: **${actor}**" \
      "_Strap in. Back in a minute._")
    ;;
  success)
    title="🎉 ${version} has landed!"
    colour=3066993   # green
    body=$(printf '%s\n%s\n%s\n\n%s' \
      "✅ Health check passed — the site is answering" \
      "🖼️ Go look: ${site}" \
      "↩️ Changed your mind? Run **Deploy** with **${previous}**" \
      "_Nothing broke. Today is a good day._")
    ;;
  failure)
    title="🚨 ${version} did not make it"
    colour=15158332  # red
    body=$(printf '%s\n%s\n%s\n\n%s' \
      "🩺 Health check: **${health_word}**" \
      "⏪ **${previous}** was put back, so the site is still up" \
      "🔎 Evidence: ${run_url}" \
      "_Deep breath. Read the log, fix it, ship again._")
    ;;
  cancelled)
    title="🛑 ${version} deploy was called off"
    colour=10070709  # grey
    body=$(printf '%s\n%s' \
      "🧍 Stopped by **${actor}** — nothing was changed" \
      "📦 Still running: **${previous}**")
    ;;
  *)
    title="ℹ️ ${version} deploy: ${state}"
    colour=10070709  # grey
    body=$(printf '%s\n%s' "📦 From **${previous}**" "🧑‍🚀 By **${actor}**")
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
  '{embeds: [{
     title: $title,
     description: $body,
     color: $colour,
     url: $url,
     timestamp: $stamp,
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
