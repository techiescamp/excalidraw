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

[ -n "${DISCORD_WEBHOOK:-}" ] || { echo "no webhook configured; not notifying"; exit 0; }

case "$state" in
  starting)
    title="Deploying ${version} to production"
    colour=3447003   # blue
    body="from **${previous}**\nby **${actor}**"
    ;;
  success)
    title="${version} is live"
    colour=3066993   # green
    body="health check **passed**\nrollback: run Deploy with **${previous}**"
    ;;
  failure)
    title="${version} FAILED"
    colour=15158332  # red
    body="health check: **${health:-not reached}**\nthe previous release **${previous}** was put back\ncheck the workflow run and the service log"
    ;;
  *)
    title="${version} deploy ${state}"
    colour=10070709  # grey
    body="from ${previous}, by ${actor}"
    ;;
esac

# jq builds the JSON so a quote or newline in any value cannot break the payload.
payload=$(jq -n \
  --arg title "$title" \
  --arg body "$body" \
  --arg footer "${GITHUB_REPOSITORY:-}" \
  --argjson colour "$colour" \
  '{embeds: [{title: $title, description: $body, color: $colour, footer: {text: $footer}}]}')

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
