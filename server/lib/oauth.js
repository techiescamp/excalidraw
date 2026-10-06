import crypto from "node:crypto";
import express from "express";
import { fail, sha256, audit } from "./core.js";

// OAuth 2.1 for MCP clients: PKCE is required, clients register themselves, and
// every token belongs to the person who approved it, so tool calls inherit that
// person's permissions exactly as a browser session would.
const CODE_TTL_SECONDS = 300;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_DAYS = 90;
const SCOPES = {
  "drawings.read": "See your drawings, collections and their contents",
  "drawings.write": "Create and change drawings",
  offline_access: "Stay connected without signing in again",
};
const DEFAULT_SCOPE = "drawings.read offline_access";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c]),
  );
const token = () => crypto.randomBytes(32).toString("base64url");
const scopeList = (value) =>
  String(value || "")
    .split(/[\s+]+/)
    .filter((scope) => Object.hasOwn(SCOPES, scope));

// Loopback redirects are how native clients (Claude Code) receive the code; the
// port varies per run, so the host is checked and the port deliberately is not.
const redirectAllowed = (uri) => {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return !url.hash;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  );
};

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(
    title,
  )}</title><link rel="stylesheet" href="/dashboard/styles.css">
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5fa;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1a21}
 .card{width:min(420px,calc(100vw - 32px));background:#fff;border:1px solid #e6e3f0;border-radius:14px;padding:28px;box-shadow:0 10px 40px #24203914}
 h1{font-size:20px;margin:0 0 6px}
 p{color:#56525f;margin:8px 0}
 ul{margin:14px 0;padding-left:20px;color:#1b1a21}
 li{margin:6px 0}
 label{display:block;margin:14px 0 0;font-size:13px;font-weight:600}
 input{width:100%;box-sizing:border-box;margin-top:6px;padding:10px;border:1px solid #dcd9e8;border-radius:8px;font:inherit}
 .row{display:flex;gap:10px;margin-top:22px}
 button{flex:1;padding:11px;border-radius:8px;border:1px solid #dcd9e8;background:#fff;font:inherit;font-weight:600;cursor:pointer}
 button.primary{background:#6965db;border-color:#6965db;color:#fff}
 .error{color:#cf3c4f;margin-top:12px}
 .client{font-weight:600}
 .muted{font-size:13px;color:#817d8d}
</style></head><body><main class="card">${body}</main></body></html>`;

const html = (res, markup, status = 200, formTarget = "") =>
  res
    .status(status)
    .type("html")
    .set({
      // form-action also governs the redirect a submission ends on, so the
      // client's own callback origin has to be listed or the browser blocks it
      "Content-Security-Policy": `default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'${
        formTarget ? " " + formTarget : ""
      }; frame-ancestors 'none'`,
      // never cached, so a refresh re-renders instead of replaying the approval
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .send(markup);

const callbackOrigin = (uri) => {
  try {
    return new URL(String(uri)).origin;
  } catch {
    return "";
  }
};

export function installOAuth(app, db, origin, security) {
  const { sessionUser, signIn } = security;
  const form = express.urlencoded({ extended: false });
  const metadata = {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: Object.keys(SCOPES),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  };
  const resource = {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: Object.keys(SCOPES),
    bearer_methods_supported: ["header"],
  };
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
  ])
    app.get(path, (_req, res) => res.json(metadata));
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])
    app.get(path, (_req, res) => res.json(resource));

  // Dynamic client registration (RFC 7591). Claude registers itself on first use.
  app.post("/oauth/register", express.json(), async (req, res) => {
    const uris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris
      : [];
    if (!uris.length || !uris.every(redirectAllowed))
      return res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "HTTPS or loopback redirect URIs only.",
      });
    const name = String(req.body?.client_name || "MCP client").slice(0, 120);
    const clientId = "mcp-" + crypto.randomUUID();
    await db.query(
      "INSERT INTO oauth_clients(client_id,name,redirect_uris) VALUES($1,$2,$3)",
      [clientId, name, uris],
    );
    res.status(201).json({
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  const client = async (id) =>
    (await db.query("SELECT * FROM oauth_clients WHERE client_id=$1", [id]))
      .rows[0];
  // Only the request's own parameters travel back in the URL: credentials posted
  // to the sign-in form must never reach a redirect, a log or a referrer header.
  const back = (source) =>
    `/oauth/authorize?${new URLSearchParams(fields(source)).toString()}`;

  const request = async (source) => {
    const found = await client(source.client_id);
    if (!found) fail(400, "Unknown client. Add the connector again.");
    const redirect = String(source.redirect_uri || "");
    if (!found.redirect_uris.includes(redirect))
      fail(400, "This redirect address is not registered for the client.");
    if (source.response_type !== "code")
      fail(400, "Only the authorization code flow is supported.");
    if (
      source.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(source.code_challenge || ""))
    )
      fail(400, "A PKCE challenge (S256) is required.");
    const scopes = scopeList(source.scope).length
      ? scopeList(source.scope)
      : scopeList(DEFAULT_SCOPE);
    return { found, redirect, scopes };
  };

  const consentPage = (found, scopes, source, user, error) =>
    page(
      "Connect " + found.name,
      `<h1>Connect <span class="client">${escape(found.name)}</span></h1>
<p>Signed in as <strong>${escape(
        user.display_name || user.username,
      )}</strong>.</p>
<p>It will be able to:</p><ul>${scopes
        .map((scope) => `<li>${escape(SCOPES[scope])}</li>`)
        .join("")}</ul>
<p class="muted">It acts as you, so it can only reach what you can reach. You can disconnect it at any time.</p>
${error ? `<p class="error">${escape(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${Object.entries(source)
  .map(
    ([key, value]) =>
      `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`,
  )
  .join("")}
<div class="row"><button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="allow">Connect</button></div>
</form>`,
    );

  const signInPage = (found, source, error) =>
    page(
      "Sign in",
      `<h1>Sign in to connect</h1><p><span class="client">${escape(
        found.name,
      )}</span> wants to use your Excalidraw workspace.</p>
${error ? `<p class="error">${escape(error)}</p>` : ""}
<form method="post" action="/oauth/sign-in">
${Object.entries(source)
  .map(
    ([key, value]) =>
      `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`,
  )
  .join("")}
<label>Username<input name="username" autocomplete="username" autofocus required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<div class="row"><button class="primary" type="submit">Sign in</button></div></form>`,
    );

  const fields = (source) => ({
    client_id: source.client_id || "",
    redirect_uri: source.redirect_uri || "",
    response_type: source.response_type || "code",
    scope: source.scope || "",
    state: source.state || "",
    code_challenge: source.code_challenge || "",
    code_challenge_method: source.code_challenge_method || "",
  });

  app.get("/oauth/authorize", async (req, res) => {
    const { found, scopes } = await request(req.query);
    const user = await sessionUser(req.cookies.ex_session);
    html(
      res,
      user
        ? consentPage(found, scopes, fields(req.query), user)
        : signInPage(found, fields(req.query)),
      200,
      callbackOrigin(req.query.redirect_uri),
    );
  });

  app.post("/oauth/sign-in", form, async (req, res) => {
    const { found } = await request(req.body);
    const user = await signIn(req, res, req.body.username, req.body.password);
    if (!user)
      return html(
        res,
        signInPage(found, fields(req.body), "Invalid username or password."),
        401,
        callbackOrigin(req.body.redirect_uri),
      );
    res.redirect(back(req.body));
  });

  app.post("/oauth/authorize", form, async (req, res) => {
    const { found, redirect, scopes } = await request(req.body);
    const user = await sessionUser(req.cookies.ex_session);
    if (!user)
      return html(
        res,
        signInPage(found, fields(req.body)),
        200,
        callbackOrigin(req.body.redirect_uri),
      );
    const target = new URL(redirect);
    if (req.body.state) target.searchParams.set("state", req.body.state);
    if (req.body.decision !== "allow") {
      target.searchParams.set("error", "access_denied");
      return res.redirect(target.href);
    }
    const code = token();
    await db.query(
      `INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,scope,code_challenge,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(secs=>$7))`,
      [
        sha256(code),
        found.client_id,
        user.id,
        redirect,
        scopes.join(" "),
        req.body.code_challenge,
        CODE_TTL_SECONDS,
      ],
    );
    await audit(db, user.id, "oauth.authorize", found.client_id);
    target.searchParams.set("code", code);
    res.redirect(target.href);
  });

  const issue = async (row, scope) => {
    const access = token(),
      refresh = scope.includes("offline_access") ? token() : null;
    await db.query(
      `INSERT INTO oauth_tokens(token_hash,kind,client_id,user_id,scope,expires_at)
       VALUES($1,'access',$2,$3,$4,now()+make_interval(secs=>$5))`,
      [sha256(access), row.client_id, row.user_id, scope, ACCESS_TTL_SECONDS],
    );
    if (refresh)
      await db.query(
        `INSERT INTO oauth_tokens(token_hash,kind,client_id,user_id,scope,expires_at)
         VALUES($1,'refresh',$2,$3,$4,now()+make_interval(days=>$5))`,
        [sha256(refresh), row.client_id, row.user_id, scope, REFRESH_TTL_DAYS],
      );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope,
      ...(refresh ? { refresh_token: refresh } : {}),
    };
  };

  app.post("/oauth/token", form, async (req, res) => {
    const deny = (error, description) =>
      res.status(400).json({ error, error_description: description });
    const grant = req.body?.grant_type;
    if (grant === "authorization_code") {
      const { rows } = await db.query(
        "SELECT * FROM oauth_codes WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",
        [sha256(String(req.body.code || ""))],
      );
      const code = rows[0];
      if (!code) return deny("invalid_grant", "The code expired or was used.");
      if (
        code.client_id !== req.body.client_id ||
        code.redirect_uri !== req.body.redirect_uri
      )
        return deny("invalid_grant", "Client or redirect does not match.");
      const verifier = String(req.body.code_verifier || "");
      const challenge = crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (!verifier || challenge !== code.code_challenge)
        return deny("invalid_grant", "PKCE verification failed.");
      await db.query(
        "UPDATE oauth_codes SET consumed_at=now() WHERE code_hash=$1",
        [code.code_hash],
      );
      return res.json(await issue(code, code.scope));
    }
    if (grant === "refresh_token") {
      const { rows } = await db.query(
        `SELECT t.* FROM oauth_tokens t JOIN users u ON u.id=t.user_id
         WHERE t.token_hash=$1 AND t.kind='refresh' AND t.revoked_at IS NULL AND t.expires_at>now()
          AND u.is_active AND NOT u.pending_setup`,
        [sha256(String(req.body.refresh_token || ""))],
      );
      const old = rows[0];
      if (!old) return deny("invalid_grant", "Sign in again.");
      // Public clients must rotate refresh tokens, so the old one dies here.
      await db.query("UPDATE oauth_tokens SET revoked_at=now() WHERE id=$1", [
        old.id,
      ]);
      return res.json(await issue(old, old.scope));
    }
    return deny(
      "unsupported_grant_type",
      "Use authorization_code or refresh_token.",
    );
  });

  app.post("/oauth/revoke", form, async (req, res) => {
    await db.query(
      "UPDATE oauth_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
      [sha256(String(req.body?.token || ""))],
    );
    res.json({});
  });

  // Used by the MCP endpoint to turn a bearer token into the person behind it.
  return async function bearerHolder(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
      return null;
    const { rows } = await db.query(
      `SELECT t.scope,t.client_id,u.id,u.username,u.display_name,u.is_superadmin
       FROM oauth_tokens t JOIN users u ON u.id=t.user_id
       WHERE t.token_hash=$1 AND t.kind='access' AND t.revoked_at IS NULL AND t.expires_at>now()
        AND u.is_active AND NOT u.pending_setup`,
      [sha256(value)],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      keyId: "oauth:" + row.client_id,
      scope: row.scope.includes("drawings.write") ? "write" : "read",
      workspaceId: null,
      user: {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        is_superadmin: row.is_superadmin,
      },
    };
  };
}
