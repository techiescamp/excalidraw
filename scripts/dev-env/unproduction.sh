#!/usr/bin/env bash
# Turns a droplet restored from a production snapshot into a development box.
# Runs on that droplet, as root, once after it is created. Re-running it is
# harmless.
#
#   sudo DEV_CONFIRM=yes bash unproduction.sh
#
# What it changes and why is the table in docs/specs/dev-environment.md. The
# short version: this host answers on an IP over plain HTTP, so nothing on it
# may hold a credential production would accept, and no real account's password
# may work on it.
#
# It refuses to run on the production host. The check is that the production
# domain must not resolve to this machine, and a domain that cannot be resolved
# at all counts as "could be this machine" unless DEV_FORCE=yes says otherwise.
set -euo pipefail

PRODUCTION_DOMAIN="${PRODUCTION_DOMAIN:-draw.devopsproject.dev}"
ENV_FILE=/etc/excalidraw-api.env
SITE=/etc/nginx/sites-available/excalidraw
DEV_SITE=/etc/nginx/sites-available/excalidraw-dev
APP=/opt/excalidraw
DB_NAME="${DEV_DB_NAME:-excalidraw}"
SOCKET_DB="postgresql://postgres@/${DB_NAME}?host=/var/run/postgresql"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGURE="$here/configure.mjs"

say() { printf '[unproduction] %s\n' "$*"; }
die() { printf '[unproduction] error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "must run as root"

# dev-env.sh leaves the settings here rather than passing them as arguments,
# because a command line is readable by every account on the machine. The file
# holds an object-store secret, so it is read once and removed.
if [ -f "$here/settings" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$here/settings"
  set +a
  rm -f "$here/settings"
fi
[ "${DEV_CONFIRM:-}" = yes ] ||
  die "set DEV_CONFIRM=yes; this rewrites every credential on this host"

# ── refuse to run on production ──────────────────────────────────────────────
public_ip=$(curl -fsS --max-time 5 \
  http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || true)
if ! [[ "$public_ip" =~ ^[0-9.]+$ ]]; then
  public_ip=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
fi
[[ "$public_ip" =~ ^[0-9.]+$ ]] || die "could not determine this host's public address"

production_ips=$(getent ahostsv4 "$PRODUCTION_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u)
if [ -z "$production_ips" ]; then
  [ "${DEV_FORCE:-}" = yes ] ||
    die "$PRODUCTION_DOMAIN does not resolve, so this host cannot be shown not to be it. Set DEV_FORCE=yes only if you are certain."
  say "warning: $PRODUCTION_DOMAIN does not resolve; continuing because DEV_FORCE=yes"
fi
for ip in $production_ips; do
  if [ "$ip" = "$public_ip" ]; then
    die "$PRODUCTION_DOMAIN resolves to $ip, which is this host. This is production. Refusing."
  fi
  if ip -4 -o addr show 2>/dev/null | grep -qw "$ip"; then
    die "$ip is configured on this host and is where $PRODUCTION_DOMAIN points. Refusing."
  fi
done
say "this host is $public_ip; $PRODUCTION_DOMAIN points elsewhere. Continuing."

[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing; this does not look like an Excalidraw host"
[ -f "$CONFIGURE" ] || die "configure.mjs must sit next to this script"
command -v node >/dev/null || die "node is needed to rewrite the configuration"

systemctl stop excalidraw-api 2>/dev/null || true

# ── the service environment ──────────────────────────────────────────────────
# A fresh JWT_SECRET does three jobs at once: tokens minted by production stop
# being accepted here, tokens minted here would not be accepted there, and the
# Spaces credentials saved in the database — encrypted under the old secret —
# become unreadable to this host.
cp -a "$ENV_FILE" "${ENV_FILE}.production-snapshot"

# Values reach the rewriter through the environment, never through a command
# line, so a key cannot be read off a process list. What it does to the file is
# covered by configure.test.mjs.
NEW_APP_ORIGIN="http://$public_ip" \
NEW_JWT_SECRET="$(openssl rand -hex 48)" \
DEV_S3_KEY_ID="${DEV_S3_KEY_ID:-}" \
DEV_S3_SECRET="${DEV_S3_SECRET:-}" \
DEV_S3_BUCKET="${DEV_S3_BUCKET:-}" \
DEV_S3_ENDPOINT="${DEV_S3_ENDPOINT:-}" \
DEV_S3_REGION="${DEV_S3_REGION:-}" \
  node "$CONFIGURE" env "$ENV_FILE"
chmod 640 "$ENV_FILE"
chown root:excalidraw "$ENV_FILE" 2>/dev/null || true
say "environment rewritten; the snapshot's copy is at ${ENV_FILE}.production-snapshot"

# ── the database ─────────────────────────────────────────────────────────────
# Every credential that could be used against this box, or that points at a
# production integration, goes. Drawings, workspaces, icons and members stay:
# real data at real scale is the reason this environment exists.
sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

-- A null hash is checked against a dummy hash by the sign-in path, so these
-- accounts are denied cleanly rather than erroring.
UPDATE users SET password_hash = NULL;

DO $do$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'users' AND column_name = 'pending_setup') THEN
    -- Otherwise the first-login setup flow would hand out these accounts.
    EXECUTE 'UPDATE users SET pending_setup = false';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'refresh_tokens', 'oauth_tokens', 'oauth_codes', 'oauth_clients',
    'mcp_keys', 'password_tokens', 'password_reset_requests'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I', t);
    END IF;
  END LOOP;
END $do$;

-- Holds the production Spaces key, encrypted under the old JWT_SECRET. The
-- environment's storage settings apply once it is gone.
DELETE FROM app_settings WHERE key = 'storage';

COMMIT;
SQL
say "credentials cleared from the database; drawings left untouched"

# ── one account that can sign in ─────────────────────────────────────────────
# Done in node, with the application's own argon2 settings and a parameterised
# update, so the hash never passes through a shell argument or SQL text.
# The program is written next to the application so its own `argon2` and `pg`
# are what get imported, and run as postgres because that is who the socket
# trusts.
enable_account="$APP/api/.dev-enable-account.mjs"
cleanup_account() { rm -f "$enable_account"; }
trap cleanup_account EXIT

cat > "$enable_account" <<'JS'
import crypto from "node:crypto";
import argon2 from "argon2";
import pg from "pg";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const wanted = process.env.DEV_ADMIN_USERNAME || "";
const { rows } = wanted
  ? await db.query(
      "SELECT username FROM users WHERE lower(username::text)=lower($1)",
      [wanted],
    )
  : await db.query(
      "SELECT username FROM users WHERE is_superadmin ORDER BY created_at LIMIT 1",
    );
if (!rows[0]) {
  throw new Error("no such account to enable; pass DEV_ADMIN_USERNAME");
}
// Long enough that a box on a public address is not worth guessing at, and
// free of characters that complicate pasting it into a login form.
const password = crypto.randomBytes(24).toString("base64url");
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
});
await db.query(
  "UPDATE users SET password_hash=$2, is_active=true WHERE username=$1",
  [rows[0].username, hash],
);
await db.end();
process.stdout.write(`${rows[0].username} ${password}\n`);
JS
chmod 644 "$enable_account"

read -r dev_user dev_password < <(
  cd "$APP/api" && sudo -u postgres env \
    DATABASE_URL="$SOCKET_DB" \
    DEV_ADMIN_USERNAME="${DEV_ADMIN_USERNAME:-}" \
    node "$enable_account"
)
cleanup_account
[ -n "${dev_password:-}" ] || die "could not enable a development account"

# Printed nowhere. Whoever owns the box reads it off the box.
( umask 077 && printf 'username: %s\npassword: %s\n' "$dev_user" "$dev_password" \
    > /root/dev-admin-password )
chmod 600 /root/dev-admin-password
unset dev_password
say "one account can sign in: $dev_user, password in /root/dev-admin-password"

# ── no backups from a clone ──────────────────────────────────────────────────
# The timer dumps this database and uploads it into the production backup
# prefix in Spaces, which would quietly replace production's own backups.
systemctl disable --now excalidraw-backup.timer 2>/dev/null || true
systemctl disable --now excalidraw-backup.service 2>/dev/null || true
say "backup timer disabled"

# ── nginx: port 80, by IP, no TLS ────────────────────────────────────────────
# certbot moved the real configuration into a 443 block and left an 80 block
# that redirects to HTTPS. On an IP that redirect leads to a certificate for
# another name, so a dev site is generated from the production one instead of
# editing it: the original stays on disk, readable, and is put back if the
# generated one does not validate.
if [ -f "$SITE" ]; then
  node "$CONFIGURE" nginx "$SITE" "$DEV_SITE"
  ln -sfn "$DEV_SITE" /etc/nginx/sites-enabled/excalidraw-dev
  rm -f /etc/nginx/sites-enabled/excalidraw /etc/nginx/sites-enabled/default
  if ! nginx -t 2>/tmp/nginx-dev-test; then
    cat /tmp/nginx-dev-test >&2
    rm -f /etc/nginx/sites-enabled/excalidraw-dev
    ln -sfn "$SITE" /etc/nginx/sites-enabled/excalidraw
    die "the generated nginx site did not validate; the production site was put back"
  fi
  systemctl reload nginx
  say "nginx serving on port 80 by IP"
fi

# ── the editor the snapshot came with ────────────────────────────────────────
# Its API address is compiled in and points at production, so serving it here
# would send this box's writes to the live site. A placeholder takes its place
# until the pipeline installs a build made for this address.
current="$APP/app/current"
if [ -L "$current" ] && grep -rqs "$PRODUCTION_DOMAIN" "$current/assets/" 2>/dev/null; then
  placeholder="$APP/app/releases/dev-placeholder"
  mkdir -p "$placeholder"
  cat > "$placeholder/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>Development box</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 4rem auto; max-width: 34rem; padding: 0 1rem; }
  code { background: #f1f1f1; padding: .15em .35em; border-radius: .25em; }
</style>
<h1>No editor installed yet</h1>
<p>This is the development box. The editor it was cloned with had the
production API address compiled into it, so it was removed rather than served
from here — it would have sent this box's drawings to the live site.</p>
<p>Run the <strong>Deploy to dev</strong> workflow, or push to <code>dev</code>,
to install a build made for this address.</p>
HTML
  chown -R excalidraw:excalidraw "$placeholder"
  ln -sfn "$placeholder" "$current"
  say "the inherited editor bundle was replaced with a placeholder"
fi

# ── mark the host ────────────────────────────────────────────────────────────
cat > /etc/excalidraw-dev <<EOF
environment=development
address=http://$public_ip
prepared=$(date -u +%Y-%m-%dT%H:%M:%SZ)
storage=$([ -n "${DEV_S3_BUCKET:-}" ] && echo "spaces:${DEV_S3_BUCKET}" || echo "local disk")
EOF

systemctl start excalidraw-api
sleep 3

# ── read the result back ─────────────────────────────────────────────────────
code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:4000/api/me" || echo 000)
say "api /api/me answered $code (401 is correct: it is up, nobody is signed in)"
[ "$code" = "401" ] || [ "$code" = "200" ] || die "the API is not answering"

say ""
say "prepared as a development box:"
cat /etc/excalidraw-dev
say ""
say "sign in at http://$public_ip/ — the one working account is in"
say "/root/dev-admin-password. Every other account's password was removed."
if [ -z "${DEV_S3_BUCKET:-}" ]; then
  say ""
  say "storage is local disk, so images saved in production will not load here."
  say "Pass DEV_S3_* to use a copy of the bucket instead."
fi
