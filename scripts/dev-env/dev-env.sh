#!/usr/bin/env bash
# Creates, prepares and destroys the development droplet described in
# docs/specs/dev-environment.md.
#
#   dev-env.sh up            create a droplet from the newest production snapshot
#   dev-env.sh prepare       turn that clone into a development box
#   dev-env.sh storage       point its storage at a Spaces bucket, or local disk
#   dev-env.sh status        what exists right now
#   dev-env.sh ssh [cmd]     open a shell on it
#   dev-env.sh sync-bucket   copy the production bucket to a dev bucket
#   dev-env.sh down          destroy it
#
# Needs doctl, authenticated as an account that can see the snapshot. Nothing
# here reads a token from a file in the repository; doctl's own context is used.
#
# The droplet is created behind a firewall that admits only one address, because
# it is a copy of production data answering over plain HTTP.
set -euo pipefail

NAME="${DEV_NAME:-excalidraw-dev}"
TAG="${DEV_TAG:-excalidraw-dev}"
SIZE="${DEV_SIZE:-s-2vcpu-4gb}"
SNAPSHOT_MATCH="${DEV_SNAPSHOT_MATCH:-excalidraw}"
SSH_USER="${DEV_USER:-deploy}"
SSH_KEY="${SSH_KEY:-$HOME/work-dir/keys/devops-key}"
PRODUCTION_DOMAIN="${PRODUCTION_DOMAIN:-draw.devopsproject.dev}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null || die "$1 is not installed"; }

doctl_ready() {
  need doctl
  doctl account get >/dev/null 2>&1 ||
    die "doctl is not authenticated; run 'doctl auth init' first"
}

# The droplet's id, or empty. Looked up by name every time rather than cached,
# so the script cannot act on a droplet that has since been destroyed.
droplet_id() {
  doctl compute droplet list --format ID,Name --no-header |
    awk -v n="$NAME" '$2 == n { print $1; exit }'
}

droplet_ip() {
  local id="${1:?id}"
  doctl compute droplet get "$id" --format PublicIPv4 --no-header
}

require_droplet() {
  local id
  id=$(droplet_id)
  [ -n "$id" ] || die "no droplet named $NAME; run '$0 up' first"
  printf '%s' "$id"
}

# The newest snapshot whose name contains the match string. Taking the newest
# rather than asking means a refresh is "take a snapshot, run up again".
resolve_snapshot() {
  if [ -n "${DEV_SNAPSHOT:-}" ]; then
    printf '%s' "$DEV_SNAPSHOT"
    return
  fi
  local line
  line=$(doctl compute snapshot list --resource droplet \
            --format ID,Name,CreatedAt,Region --no-header |
          grep -i -- "$SNAPSHOT_MATCH" | sort -k3 | tail -1)
  [ -n "$line" ] ||
    die "no droplet snapshot whose name contains '$SNAPSHOT_MATCH'; set DEV_SNAPSHOT"
  say "snapshot: $line" >&2
  awk '{ print $1 }' <<<"$line"
}

snapshot_region() {
  doctl compute snapshot get "${1:?id}" --format Regions --no-header |
    tr -d '[]' | awk -F',' '{ print $1 }' | tr -d ' '
}

# Every key on the account, so whoever created the droplet can reach it. A
# narrower set is passed in DEV_SSH_KEYS when that is not wanted.
ssh_keys() {
  if [ -n "${DEV_SSH_KEYS:-}" ]; then
    printf '%s' "$DEV_SSH_KEYS"
    return
  fi
  local keys
  keys=$(doctl compute ssh-key list --format ID --no-header | paste -sd, -)
  [ -n "$keys" ] || die "no SSH keys on the account; add one or set DEV_SSH_KEYS"
  printf '%s' "$keys"
}

allow_cidr() {
  if [ -n "${DEV_ALLOW_CIDR:-}" ]; then
    printf '%s' "$DEV_ALLOW_CIDR"
    return
  fi
  local ip
  ip=$(curl -fsS --max-time 10 https://api.ipify.org || true)
  [[ "$ip" =~ ^[0-9.]+$ ]] ||
    die "could not work out this machine's address; set DEV_ALLOW_CIDR"
  printf '%s/32' "$ip"
}

# A firewall that admits SSH and HTTP from one address and nothing else. It is
# attached by tag, and the attachment is read back, because a firewall that
# silently covered the production droplet as well would be a very bad surprise.
ensure_firewall() {
  local cidr="$1" id="$2" fw
  fw=$(doctl compute firewall list --format ID,Name --no-header |
         awk -v n="$NAME" '$2 == n { print $1; exit }')
  local inbound="protocol:tcp,ports:22,address:${cidr} protocol:tcp,ports:80,address:${cidr}"
  local outbound="protocol:tcp,ports:all,address:0.0.0.0/0 protocol:udp,ports:all,address:0.0.0.0/0 protocol:icmp,address:0.0.0.0/0"

  if [ -z "$fw" ]; then
    say "firewall: creating $NAME, admitting $cidr"
    doctl compute firewall create --name "$NAME" \
      --inbound-rules "$inbound" --outbound-rules "$outbound" \
      --tag-names "$TAG" --format ID --no-header >/dev/null
  else
    say "firewall: updating $NAME to admit $cidr"
    doctl compute firewall update "$fw" --name "$NAME" \
      --inbound-rules "$inbound" --outbound-rules "$outbound" \
      --tag-names "$TAG" --format ID --no-header >/dev/null
  fi

  # Read the attachment back. This firewall is attached by tag, so DigitalOcean
  # reports no droplet ids against it at all — checking those alone looked like
  # a check and was not one. What matters is which droplets carry the tag: if
  # production ever wore it, this would be rewriting production's firewall.
  local tagged
  tagged=$(doctl compute droplet list --tag-name "$TAG" --format ID --no-header |
             paste -sd, -)
  [ -n "$tagged" ] ||
    die "no droplet carries the '$TAG' tag, so firewall $NAME protects nothing"
  if [ "$tagged" != "$id" ]; then
    die "the '$TAG' tag is on droplets [$tagged] but the dev droplet is $id; firewall $NAME would cover them too. Fix the tag before continuing"
  fi

  local covered
  covered=$(doctl compute firewall list --format Name,DropletIDs --no-header |
              awk -v n="$NAME" '$1 == n { $1=""; print }' | tr -d ' ,')
  if [ -n "$covered" ] && [ "$covered" != "$id" ]; then
    die "firewall $NAME is also attached directly to droplets [$covered]; fix that before continuing"
  fi
  say "firewall: $NAME admits $cidr, and covers only droplet $id"
}

cmd_up() {
  doctl_ready
  local existing
  existing=$(droplet_id)
  if [ -n "$existing" ]; then
    say "$NAME already exists at $(droplet_ip "$existing")"
    say "run '$0 prepare' to configure it, or '$0 down' to destroy it"
    return 0
  fi

  local snapshot region keys cidr
  snapshot=$(resolve_snapshot)
  region="${DEV_REGION:-$(snapshot_region "$snapshot")}"
  [ -n "$region" ] || die "could not work out a region; set DEV_REGION"
  keys=$(ssh_keys)
  cidr=$(allow_cidr)

  say "creating $NAME in $region from snapshot $snapshot"
  doctl compute droplet create "$NAME" \
    --image "$snapshot" --size "$SIZE" --region "$region" \
    --ssh-keys "$keys" --tag-name "$TAG" \
    --wait --format ID,PublicIPv4 --no-header

  local id ip
  id=$(require_droplet)
  ip=$(droplet_ip "$id")
  ensure_firewall "$cidr" "$id"

  say ""
  say "$NAME is up at $ip"
  say "it is still a copy of production. Nothing may be opened in a browser"
  say "until it has been through:"
  say ""
  say "  $0 prepare"
}

# Everything that makes the clone safe happens in one script that runs on the
# droplet, so it can be read in one piece and re-run.
cmd_prepare() {
  doctl_ready
  local id ip
  id=$(require_droplet)
  ip=$(droplet_ip "$id")
  for file in unproduction.sh configure.mjs; do
    [ -f "$here/$file" ] || die "cannot find $here/$file"
  done

  say "preparing $ip"
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" \
    'rm -rf /tmp/dev-env && mkdir -m 700 -p /tmp/dev-env'
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
    "$here/unproduction.sh" "$here/configure.mjs" "$SSH_USER@$ip:/tmp/dev-env/"

  # The settings travel as a file written over the connection, not as arguments
  # to the remote command: a Spaces secret on a command line is readable in the
  # droplet's process list by anyone with an account on it. unproduction.sh
  # reads the file and deletes it.
  {
    printf 'DEV_CONFIRM=%q\n' yes
    printf 'PRODUCTION_DOMAIN=%q\n' "$PRODUCTION_DOMAIN"
    printf 'DEV_ADMIN_USERNAME=%q\n' "${DEV_ADMIN_USERNAME:-}"
    printf 'DEV_S3_BUCKET=%q\n' "${DEV_S3_BUCKET:-}"
    printf 'DEV_S3_ENDPOINT=%q\n' "${DEV_S3_ENDPOINT:-}"
    printf 'DEV_S3_REGION=%q\n' "${DEV_S3_REGION:-}"
    printf 'DEV_S3_KEY_ID=%q\n' "${DEV_S3_KEY_ID:-}"
    printf 'DEV_S3_SECRET=%q\n' "${DEV_S3_SECRET:-}"
    printf 'DEV_FORCE=%q\n' "${DEV_FORCE:-}"
  } | ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" \
        'umask 077 && cat > /tmp/dev-env/settings'

  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" \
    "sudo bash /tmp/dev-env/unproduction.sh"

  say ""
  say "prepared. Add these to the repository's GitHub secrets so the pipeline"
  say "can deploy to it:"
  say "  DEV_HOST=$ip"
  say "  DEV_USER=$SSH_USER"
  say "  DEV_SSH_KEY=<the private key that matches>"
  say ""
  say "then run the 'Deploy to dev' workflow, or push to dev."
}

cmd_status() {
  doctl_ready
  local id
  id=$(droplet_id)
  if [ -z "$id" ]; then
    say "no droplet named $NAME"
    return 0
  fi
  local ip
  ip=$(droplet_ip "$id")
  doctl compute droplet get "$id" \
    --format ID,Name,PublicIPv4,Region,Memory,VCPUs,Disk,Status
  say ""
  doctl compute firewall list --format Name,Status,DropletIDs,InboundRules |
    head -1
  doctl compute firewall list --format Name,Status,DropletIDs,InboundRules \
    --no-header | grep -- "$NAME" || say "(no firewall named $NAME)"
  say ""
  # Read the marker back off the box rather than assuming prepare ever ran.
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
       "$SSH_USER@$ip" 'cat /etc/excalidraw-dev 2>/dev/null' 2>/dev/null; then
    :
  else
    say "not prepared yet, or unreachable: no /etc/excalidraw-dev on $ip"
  fi
}

cmd_ssh() {
  doctl_ready
  local ip
  ip=$(droplet_ip "$(require_droplet)")
  exec ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" "$@"
}

# Copying the bucket is the only way the dev box both sees production images and
# can write new ones without touching production storage. It needs two keys and
# takes them from the environment; neither is written anywhere.
cmd_sync_bucket() {
  need aws
  : "${PROD_S3_BUCKET:?set PROD_S3_BUCKET}"
  : "${DEV_S3_BUCKET:?set DEV_S3_BUCKET}"
  : "${S3_ENDPOINT:?set S3_ENDPOINT, for example https://sfo3.digitaloceanspaces.com}"
  [ "$PROD_S3_BUCKET" != "$DEV_S3_BUCKET" ] ||
    die "the production and dev buckets are the same bucket"
  say "copying s3://$PROD_S3_BUCKET to s3://$DEV_S3_BUCKET"
  say "this reads production storage and writes only to the dev bucket."
  aws --endpoint-url "$S3_ENDPOINT" s3 sync \
    "s3://$PROD_S3_BUCKET" "s3://$DEV_S3_BUCKET" --no-progress
  say "done. Pass DEV_S3_BUCKET, DEV_S3_ENDPOINT, DEV_S3_REGION, DEV_S3_KEY_ID"
  say "and DEV_S3_SECRET to '$0 prepare' so the droplet uses it."
}

cmd_down() {
  doctl_ready
  local id ip
  id=$(require_droplet)
  ip=$(droplet_ip "$id")
  say "This destroys droplet $NAME ($id) at $ip and everything on its disk."
  say "The snapshot it was made from is not affected."
  if [ "${1:-}" != "--yes" ]; then
    read -r -p "Type the droplet name to confirm: " answer
    [ "$answer" = "$NAME" ] || die "not confirmed; nothing was destroyed"
  fi
  doctl compute droplet delete "$id" --force
  local fw
  fw=$(doctl compute firewall list --format ID,Name --no-header |
         awk -v n="$NAME" '$2 == n { print $1; exit }')
  [ -n "$fw" ] && doctl compute firewall delete "$fw" --force
  say "destroyed"
}

# Points the droplet's storage at a bucket, without going through `prepare`
# again. Separate because the credentials belong to whoever is running this and
# should not have to be handed over to re-run everything else; and because
# getting the bucket wrong should cost one command, not a rebuild.
#
#   DEV_S3_BUCKET=… DEV_S3_KEY_ID=… DEV_S3_SECRET=… dev-env.sh storage
#
# With no DEV_S3_BUCKET it puts the droplet back on local disk.
cmd_storage() {
  doctl_ready
  local id ip
  id=$(require_droplet)
  ip=$(droplet_ip "$id")
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" \
    'grep -q "^environment=development$" /etc/excalidraw-dev' ||
    die "$ip has no /etc/excalidraw-dev marker; it has not been through prepare"

  [ -f "$here/configure.mjs" ] || die "cannot find $here/configure.mjs"
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" \
    'rm -rf /tmp/dev-storage && mkdir -m 700 -p /tmp/dev-storage'
  scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
    "$here/configure.mjs" "$SSH_USER@$ip:/tmp/dev-storage/"

  # Over the connection as a file, never as arguments: a Spaces secret on a
  # command line is readable in the droplet's process list.
  {
    printf 'DEV_S3_BUCKET=%q\n' "${DEV_S3_BUCKET:-}"
    printf 'DEV_S3_ENDPOINT=%q\n' "${DEV_S3_ENDPOINT:-https://blr1.digitaloceanspaces.com}"
    printf 'DEV_S3_REGION=%q\n' "${DEV_S3_REGION:-blr1}"
    printf 'DEV_S3_KEY_ID=%q\n' "${DEV_S3_KEY_ID:-}"
    printf 'DEV_S3_SECRET=%q\n' "${DEV_S3_SECRET:-}"
  } | ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" \
      'umask 077 && cat > /tmp/dev-storage/settings'

  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" \
    'sudo bash -s' <<'REMOTE'
set -euo pipefail
. /tmp/dev-storage/settings
rm -f /tmp/dev-storage/settings
ENV_FILE=/etc/excalidraw-api.env
DEV_S3_BUCKET="${DEV_S3_BUCKET:-}" DEV_S3_ENDPOINT="${DEV_S3_ENDPOINT:-}" \
DEV_S3_REGION="${DEV_S3_REGION:-}" DEV_S3_KEY_ID="${DEV_S3_KEY_ID:-}" \
DEV_S3_SECRET="${DEV_S3_SECRET:-}" \
  node /tmp/dev-storage/configure.mjs storage "$ENV_FILE"
rm -rf /tmp/dev-storage
systemctl restart excalidraw-api
for _ in $(seq 1 30); do
  # Errors are expected while it comes back up; only the verdict is wanted.
  code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/me 2>/dev/null || echo 000)
  case "$code" in 200|401) break ;; esac
  sleep 1
done
echo "[storage] api answered $code"
sed -i "s|^storage=.*|storage=${DEV_S3_BUCKET:-local disk}|" /etc/excalidraw-dev
grep '^storage=' /etc/excalidraw-dev
REMOTE
  say "storage set. Open a drawing with images and check they render."
}

case "${1:-}" in
  up)          shift; cmd_up "$@" ;;
  prepare)     shift; cmd_prepare "$@" ;;
  storage)     shift; cmd_storage "$@" ;;
  status)      shift; cmd_status "$@" ;;
  ssh)         shift; cmd_ssh "$@" ;;
  sync-bucket) shift; cmd_sync_bucket "$@" ;;
  down)        shift; cmd_down "$@" ;;
  *) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
