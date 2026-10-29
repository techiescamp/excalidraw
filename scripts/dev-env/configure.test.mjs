// What preparing the development droplet does to two of its files, checked
// without needing a droplet. Runs with the rest of the suite:
//
//   yarn test:app --watch=false scripts/dev-env
import { describe, expect, it } from "vitest";

import { devNginxSite, rewriteEnv, storageChanges } from "./configure.mjs";

// The production host's env file, comments and all.
const PRODUCTION_ENV = `# /etc/excalidraw-api.env
DATABASE_URL=postgresql://excalidraw@localhost/excalidraw
APP_ORIGIN=https://draw.devopsproject.dev
COOKIE_SECURE=true
JWT_SECRET=the-production-signing-secret
AWS_ACCESS_KEY_ID=PRODUCTIONKEYID
AWS_SECRET_ACCESS_KEY=production/secret+value
S3_BUCKET=excalidraw-data
S3_ENDPOINT=https://sfo3.digitaloceanspaces.com
AWS_REGION=sfo3
SESSION_HOURS=12
`;

const DEV_CHANGES = {
  APP_ORIGIN: "http://203.0.113.10",
  COOKIE_SECURE: "false",
  JWT_SECRET: "a-new-secret",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  S3_BUCKET: "",
  S3_ENDPOINT: "",
  AWS_REGION: "",
  DISCORD_WEBHOOK: "",
};

const asMap = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );

describe("rewriteEnv", () => {
  it("replaces the values that must not survive the clone", () => {
    const env = asMap(rewriteEnv(PRODUCTION_ENV, DEV_CHANGES));
    expect(env.APP_ORIGIN).toBe("http://203.0.113.10");
    expect(env.COOKIE_SECURE).toBe("false");
    expect(env.JWT_SECRET).toBe("a-new-secret");
  });

  it("empties every object-storage value, so the clone cannot reach the production bucket", () => {
    const env = asMap(rewriteEnv(PRODUCTION_ENV, DEV_CHANGES));
    expect({
      keyId: env.AWS_ACCESS_KEY_ID,
      secret: env.AWS_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.AWS_REGION,
    }).toEqual({
      keyId: "",
      secret: "",
      bucket: "",
      endpoint: "",
      region: "",
    });
  });

  it("leaves everything it was not asked to change", () => {
    const result = rewriteEnv(PRODUCTION_ENV, DEV_CHANGES);
    expect(result).toMatch(/^# \/etc\/excalidraw-api\.env$/m);
    expect(asMap(result).DATABASE_URL).toBe(
      "postgresql://excalidraw@localhost/excalidraw",
    );
    expect(asMap(result).SESSION_HOURS).toBe("12");
  });

  it("adds a key the file did not have", () => {
    const result = rewriteEnv(PRODUCTION_ENV, DEV_CHANGES);
    expect(asMap(result).DISCORD_WEBHOOK).toBe("");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
  });

  it("collapses a repeated key, which would otherwise shadow the new value", () => {
    const doubled = "JWT_SECRET=first\nSESSION_HOURS=12\nJWT_SECRET=second\n";
    const result = rewriteEnv(doubled, { JWT_SECRET: "new" });
    expect(result.match(/^JWT_SECRET=/gm)).toHaveLength(1);
    expect(asMap(result).JWT_SECRET).toBe("new");
  });

  it("keeps a value containing an equals sign whole", () => {
    const result = rewriteEnv("A=one\n", { A: "k=v==" });
    expect(asMap(result).A).toBe("k=v==");
  });
});

// The production site as certbot leaves it: the real configuration inside the
// 443 block, and an 80 block that redirects to HTTPS.
const PRODUCTION_SITE = `map $http_upgrade $connection_upgrade { default upgrade; "" close; }

server {
    listen 80;
    listen [::]:80;
    server_name draw.devopsproject.dev 139.59.41.208;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name draw.devopsproject.dev;
    ssl_certificate /etc/letsencrypt/live/draw.devopsproject.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/draw.devopsproject.dev/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /opt/excalidraw/app/current;
    client_max_body_size 25m;
    include snippets/excalidraw-security.conf;

    location = /editor {
        add_header Cache-Control "no-store";
        try_files /index.html =404;
    }

    location /assets/ {
        expires 1y;
        try_files $uri =404;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;

describe("devNginxSite", () => {
  const site = devNginxSite(
    PRODUCTION_SITE,
    "/etc/nginx/sites-available/excalidraw",
  );

  it("answers on port 80 for any name, which is what an IP needs", () => {
    expect(site).toMatch(/^\s*listen 80;$/m);
    expect(site).toMatch(/^\s*listen \[::\]:80;$/m);
    expect(site).toMatch(/^\s*server_name _;$/m);
  });

  it("carries no certificate and no HTTPS redirect", () => {
    expect(site).not.toMatch(/ssl_certificate/);
    expect(site).not.toMatch(/ssl_dhparam/);
    expect(site).not.toMatch(/options-ssl-nginx/);
    expect(site).not.toMatch(/return\s+301\s+https/);
    expect(site).not.toMatch(/listen 443/);
    expect(site).not.toMatch(/http2 on/);
  });

  it("names no host, so the production name cannot be served from it", () => {
    expect(site).not.toMatch(/server_name[^\n]*draw\.devopsproject\.dev/);
  });

  it("keeps the application: the proxy, the upgrade map, the caches, the headers", () => {
    expect(site).toMatch(/map \$http_upgrade \$connection_upgrade/);
    expect(site.match(/proxy_pass http:\/\/127\.0\.0\.1:4000;/g)).toHaveLength(
      2,
    );
    expect(site).toMatch(/location = \/editor \{/);
    expect(site).toMatch(/location \/assets\/ \{/);
    expect(site).toMatch(/proxy_set_header Connection \$connection_upgrade;/);
    expect(site).toMatch(/include snippets\/excalidraw-security\.conf;/);
    expect(site).toMatch(/client_max_body_size 25m;/);
  });

  it("has balanced braces, or nginx would not start", () => {
    expect(site.match(/\{/g)).toHaveLength(site.match(/\}/g).length);
  });

  it("keeps exactly one server block", () => {
    expect(site.match(/^server \{$/gm)).toHaveLength(1);
  });

  it("says where it came from", () => {
    expect(site).toMatch(/^# Generated by/);
    expect(site).toMatch(/sites-available\/excalidraw/);
  });

  it("refuses a file it does not recognise rather than writing a broken site", () => {
    expect(() =>
      devNginxSite("server {\n    listen 80;\n    root /var/www;\n}\n"),
    ).toThrow(/no server block proxies to the API/);
  });

  it("handles a site that was never touched by certbot", () => {
    const plain = `server {
    listen 80;
    server_name draw.devopsproject.dev 139.59.41.208;
    location / {
        proxy_pass http://127.0.0.1:4000;
    }
}
`;
    const result = devNginxSite(plain);
    expect(result).toMatch(/^\s*listen 80;$/m);
    expect(result).toMatch(/^\s*server_name _;$/m);
    expect(result).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:4000;/);
  });
});

describe("storageChanges", () => {
  it("names only the five values that decide where image bytes live", () => {
    // Deliberately not APP_ORIGIN or JWT_SECRET: pointing an already-prepared
    // box at a bucket must not rewrite its origin or its signing secret, and
    // writing either of those empty would break it.
    expect(Object.keys(storageChanges({})).sort()).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
      "AWS_SECRET_ACCESS_KEY",
      "S3_BUCKET",
      "S3_ENDPOINT",
    ]);
  });

  it("empties every one of them when no bucket is given", () => {
    expect(storageChanges({})).toEqual({
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      S3_BUCKET: "",
      S3_ENDPOINT: "",
      AWS_REGION: "",
    });
  });

  it("carries a bucket through, and leaves the rest of the file alone", () => {
    const before = [
      "APP_ORIGIN=http://198.51.100.10",
      "JWT_SECRET=do-not-touch-this",
      "DATABASE_URL=postgres:///excalidraw",
      "S3_BUCKET=",
      "AWS_ACCESS_KEY_ID=",
      "",
    ].join("\n");
    const after = rewriteEnv(
      before,
      storageChanges({
        DEV_S3_BUCKET: "backups-draw",
        DEV_S3_KEY_ID: "AKIAEXAMPLE",
        DEV_S3_SECRET: "s3cret",
        DEV_S3_ENDPOINT: "https://blr1.digitaloceanspaces.com",
        DEV_S3_REGION: "blr1",
      }),
    );
    expect(after).toContain("S3_BUCKET=backups-draw");
    expect(after).toContain("AWS_ACCESS_KEY_ID=AKIAEXAMPLE");
    expect(after).toContain("AWS_REGION=blr1");
    expect(after).toContain("APP_ORIGIN=http://198.51.100.10");
    expect(after).toContain("JWT_SECRET=do-not-touch-this");
    expect(after).toContain("DATABASE_URL=postgres:///excalidraw");
  });
});
