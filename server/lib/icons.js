import crypto from "node:crypto";
import { fail, uuid, audit } from "./core.js";

// Icons live in the workspace's own library. Anything fetched from the internet
// is stored here on first use, so drawings never depend on a site staying up and
// the same icon is never downloaded twice.
// One host, fixed. The override exists so a test can point at a stub instead
// of the real site; nothing a request carries can change where this points.
const SOURCE = process.env.ICON_SOURCE_URL || "https://api.iconify.design";
const MAX_BYTES = 256 * 1024;
const MAX_WORKSPACE_ICON_BYTES = 5 * 1024 * 1024;
// Icon bytes live in PostgreSQL, which is the expensive storage and the one
// every backup carries. Without a ceiling a workspace could quietly put gigabytes
// there one 5 MB icon at a time, which is the problem the drawings themselves
// were just moved out of the database to avoid.
const MAX_WORKSPACE_LIBRARY_BYTES =
  Number(process.env.ICON_LIBRARY_MAX_BYTES) > 0
    ? Number(process.env.ICON_LIBRARY_MAX_BYTES)
    : 256 * 1024 * 1024;
const MAX_IMPORT = 40;
const MAX_CATEGORY_LENGTH = 40;
const MAX_DISPLAY_NAME_LENGTH = 80;
const WORKSPACE_ICON_MIMES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
]);
const REF = /^[a-z0-9][a-z0-9_-]{0,59}\/[a-z0-9][a-z0-9._-]{0,79}$/i;
const TIMEOUT_MS = 8000;
// Sets that draw a product the way the product draws itself. When the source
// offers the same picture from several sets, one of these is taken first, so a
// diagram gets the real logo rather than a monochrome outline of it.
const PREFERRED_SETS = [
  "logos",
  "devicon",
  "skill-icons",
  "vscode-icons",
  "simple-icons",
];
// Icons the library did not have and this server went and found are filed
// together, so whoever looks after the library can see what arrived on its own.
const FETCHED_CATEGORY = "Found online";

// Matching an icon by meaning rather than by name. An assistant describing a
// diagram knows it wants "a database" or "the queue"; it does not know that this
// library calls that picture logos/postgresql. Asking it to list every icon and
// guess is how boxes end up with no icon at all, so the words it used are
// matched against every name, label and category in the library, and words that
// mean the same thing are treated as the same word.
//
// Each group is one idea. A word from a group matches any other word in it, at
// a lower score than a direct hit, so "database" finds postgresql but an icon
// actually called "database" still wins.
const MEANINGS = [
  ["database", "db", "postgres", "postgresql", "mysql", "mariadb", "sqlite", "oracle", "mssql", "rds", "sql"],
  ["nosql", "mongodb", "mongo", "dynamodb", "cassandra", "couchdb", "firestore"],
  ["cache", "caching", "redis", "memcached", "varnish", "valkey"],
  ["queue", "messaging", "broker", "kafka", "rabbitmq", "sqs", "nats", "pubsub", "activemq", "events"],
  ["kubernetes", "k8s", "eks", "gke", "aks", "openshift", "rancher", "cluster"],
  ["container", "containers", "docker", "podman", "containerd", "image", "registry"],
  ["gateway", "ingress", "loadbalancer", "balancer", "lb", "nginx", "haproxy", "traefik", "envoy", "elb", "alb", "apigateway", "kong"],
  ["cdn", "edge", "cloudflare", "fastly", "akamai", "cloudfront"],
  ["storage", "object", "bucket", "blob", "s3", "minio", "spaces", "disk", "volume", "efs", "nfs"],
  ["cicd", "ci", "cd", "pipeline", "build", "jenkins", "argocd", "argo", "gitlab", "circleci", "travis", "tekton", "spinnaker", "actions"],
  ["git", "repo", "repository", "source", "github", "bitbucket", "gitea"],
  ["monitoring", "metrics", "observability", "prometheus", "grafana", "datadog", "newrelic", "thanos", "cloudwatch"],
  ["logs", "logging", "elasticsearch", "opensearch", "loki", "kibana", "splunk", "fluentd", "fluentbit"],
  ["tracing", "trace", "jaeger", "zipkin", "opentelemetry", "otel"],
  ["alerting", "alert", "pagerduty", "opsgenie", "alertmanager", "bell", "notification"],
  ["auth", "authentication", "identity", "sso", "oauth", "oidc", "keycloak", "auth0", "okta", "ldap", "iam", "login"],
  ["secrets", "secret", "vault", "credentials", "key", "lock", "certificate", "tls", "ssl"],
  ["security", "firewall", "waf", "shield", "guard", "protection"],
  ["cloud", "aws", "amazon", "gcp", "google", "azure", "digitalocean", "oracle", "linode", "hetzner"],
  ["dns", "domain", "route53", "coredns", "bind", "nameserver"],
  ["server", "vm", "instance", "ec2", "droplet", "host", "machine", "compute", "node"],
  ["serverless", "lambda", "function", "functions", "cloudrun", "fargate"],
  ["user", "users", "person", "people", "client", "customer", "browser", "chrome", "firefox", "laptop", "desktop", "visitor", "developer"],
  ["mobile", "phone", "android", "ios", "apple", "app"],
  ["api", "rest", "graphql", "grpc", "endpoint", "service", "backend", "openapi", "swagger"],
  ["frontend", "web", "website", "ui", "react", "vue", "angular", "svelte", "nextjs"],
  ["mail", "email", "smtp", "ses", "sendgrid", "mailgun", "postfix"],
  ["chat", "slack", "discord", "teams", "telegram", "whatsapp"],
  ["terraform", "infrastructure", "iac", "ansible", "pulumi", "cloudformation", "puppet", "chef", "helm"],
  ["linux", "ubuntu", "debian", "centos", "rhel", "redhat", "alpine", "fedora", "suse"],
  ["language", "node", "nodejs", "python", "java", "golang", "go", "rust", "ruby", "php", "dotnet", "typescript", "javascript"],
  ["ai", "llm", "model", "claude", "anthropic", "openai", "gpt", "gemini", "ollama"],
  ["payment", "billing", "stripe", "paypal", "invoice", "card"],
  ["analytics", "report", "dashboard", "chart", "bigquery", "snowflake", "warehouse", "etl", "airflow", "spark"],
  ["mesh", "istio", "linkerd", "consul", "sidecar", "proxy"],
  ["test", "testing", "qa", "jest", "cypress", "playwright", "selenium"],
];
const MEANING_OF = (() => {
  const index = new Map();
  MEANINGS.forEach((group, id) => {
    for (const word of group) {
      const groups = index.get(word) || [];
      groups.push(id);
      index.set(word, groups);
    }
  });
  return index;
})();
const words = (value) =>
  String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
// "k8s" and "s3" carry meaning; one-letter fragments do not.
const meaningful = (list) => list.filter((word) => word.length > 1);

// How well one icon answers the words asked for, and how much else its own name
// says besides. Strength is the match; the penalty only separates two icons that
// match equally, so it is kept apart rather than folded in.
function weigh(query, icon) {
  const none = { strength: 0, penalty: 0, direct: 0 };
  const asked = meaningful(words(query));
  if (!asked.length) return none;
  const ref = `${icon.set_name}/${icon.name}`.toLowerCase();
  if (query.trim().toLowerCase().replace(":", "/") === ref)
    return { strength: 100, penalty: 0, direct: asked.length };
  const name = words(icon.name);
  const shown = words(icon.display_name);
  const own = new Set([...name, ...shown]);
  const near = new Set();
  for (const word of own)
    for (const group of MEANING_OF.get(word) || [])
      for (const sibling of MEANINGS[group]) near.add(sibling);
  const set = words(icon.set_name);
  const category = words(icon.category);
  let strength = 0;
  // How many of the asked words are in the icon's own name or label, rather
  // than reached through a word that means something similar. An icon actually
  // called what was asked for is a different kind of answer from one that only
  // belongs to the same idea, and callers need to tell them apart.
  let direct = 0;
  for (const word of asked) {
    if (own.has(word)) {
      strength += 300;
      direct += 1;
    }
    else if (near.has(word)) strength += 120;
    else if ([...own].some((had) => had.includes(word) || word.includes(had)))
      strength += 90;
    // A set or category is matched loosely on purpose: a library files things
    // under "Databases" and nobody asks for a "databases".
    else if (set.some((had) => had.includes(word) || word.includes(had)))
      strength += 40;
    else if (category.some((had) => had.includes(word) || word.includes(had)))
      strength += 30;
  }
  if (!strength) return none;
  // Of two icons that answer equally well, the one whose own name says less
  // besides is the closer match: "redis" over "redis-cluster-failover".
  return {
    strength,
    direct,
    penalty: Math.min(99, own.size * 2 + ref.length),
  };
}

// One number for how well an icon answers the words. Higher is better; 0 means
// the words have nothing to do with this icon and it must not be offered.
export function scoreIcon(query, icon) {
  const { strength, penalty } = weigh(query, icon);
  return strength ? strength * 100 - penalty : 0;
}

// Below this, the words and the icon have nothing in common but a set or a
// category. Scores are built in hundreds, so this is one loose word hit.
export const MIN_MATCH = 9000;

// Icons that answer the words, best first. Rows are whatever the library holds.
// A hint is the words around the request — the label on the box the icon is
// going into. It never makes a match; it only settles which of two equally good
// matches to use, so a box labelled Prometheus asking for "metrics" does not
// come back with Grafana.
export function rankIcons(query, rows, limit = 8, hint = "") {
  return rows
    .map((icon) => ({ icon, ...weigh(query, icon) }))
    .filter((candidate) => candidate.strength > 0)
    .map((candidate) => ({
      ...candidate,
      hint: hint ? weigh(hint, candidate.icon).strength : 0,
    }))
    // Match first, then what the surrounding words prefer, and only then the
    // shorter name: a hint must be able to settle a tie the name length would
    // otherwise decide.
    .sort(
      (a, b) =>
        b.strength - a.strength || b.hint - a.hint || a.penalty - b.penalty,
    )
    .slice(0, limit)
    .map((hit) => ({
      ref: `${hit.icon.set_name}/${hit.icon.name}`,
      // How much of what was asked for this icon is actually named after,
      // out of how many words were asked. A caller deciding between this and
      // somewhere else needs the fraction, not just that something matched.
      covers: hit.direct,
      of: Math.max(1, meaningful(words(query)).length),
      name: hit.icon.display_name || hit.icon.name,
      category: hit.icon.category,
      score: hit.strength * 100 - hit.penalty,
    }));
}
// The icon source names things "set:name"; this library uses "set/name".
const normal = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(":", "/");
const categoryValue = (value) => {
  const category = String(value || "General").trim();
  if (!category || category.length > MAX_CATEGORY_LENGTH)
    fail(400, `Category must be 1–${MAX_CATEGORY_LENGTH} characters.`);
  return category;
};
const displayNameValue = (value) => {
  const displayName = String(value || "").trim();
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH)
    fail(
      400,
      `Icon name must be ${MAX_DISPLAY_NAME_LENGTH} characters or less.`,
    );
  return displayName || null;
};
const parseCanvasImage = (value) => {
  if (
    typeof value !== "string" ||
    value.length > MAX_WORKSPACE_ICON_BYTES * 1.4
  ) {
    fail(413, "Icons must be 5 MiB or smaller.");
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(
    value,
  );
  if (!match) fail(400, "Choose a supported image from the canvas.");
  const mime = match[1].toLowerCase();
  if (!WORKSPACE_ICON_MIMES.has(mime)) {
    fail(415, "That image format is not supported for icons.");
  }
  const body = Buffer.from(match[2], "base64");
  if (
    !body.length ||
    body.length > MAX_WORKSPACE_ICON_BYTES ||
    body.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")
  ) {
    fail(400, "The image data is invalid.");
  }

  const startsWith = (...bytes) =>
    body.length >= bytes.length &&
    bytes.every((byte, index) => body[index] === byte);
  const signatureMatches =
    mime === "image/svg+xml"
      ? (() => {
          const svg = body.toString("utf8");
          return (
            /<svg\b/i.test(svg) &&
            !/<\s*(?:script|foreignObject|!doctype|!entity)\b|\bon[a-z]+\s*=|javascript:|(?:href|xlink:href)\s*=\s*["'](?!#)|url\s*\(\s*["']?(?!#)/i.test(
              svg,
            )
          );
        })()
      : mime === "image/png"
      ? startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
      : mime === "image/jpeg" || mime === "image/jfif"
      ? startsWith(0xff, 0xd8, 0xff)
      : mime === "image/gif"
      ? body
          .subarray(0, 6)
          .toString("ascii")
          .match(/^GIF8[79]a$/)
      : mime === "image/webp"
      ? body.subarray(0, 4).toString("ascii") === "RIFF" &&
        body.subarray(8, 12).toString("ascii") === "WEBP"
      : mime === "image/bmp"
      ? body.subarray(0, 2).toString("ascii") === "BM"
      : mime === "image/x-icon"
      ? startsWith(0x00, 0x00, 0x01, 0x00) || startsWith(0x00, 0x00, 0x02, 0x00)
      : mime === "image/avif"
      ? body.subarray(4, 8).toString("ascii") === "ftyp" &&
        /^(?:avif|avis)$/.test(body.subarray(8, 12).toString("ascii"))
      : false;
  if (!signatureMatches) fail(400, "The image data does not match its format.");
  return { body, mime };
};
const safeIconName = (value) => {
  const slug = String(value || "icon")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 60);
  return `${slug || "icon"}-${crypto.randomUUID().slice(0, 8)}`;
};

export function installIcons(
  app,
  db,
  storage,
  { auth, admin, recent, permit },
) {
  const settings = async () =>
    (await db.query("SELECT value FROM app_settings WHERE key='icons'")).rows[0]
      ?.value || { fetch_enabled: false };

  // Only this one host, only SVG, only small files: a fetch triggered by a model
  // must never become a way to reach arbitrary addresses from this server.
  const download = async (set, name) => {
    const response = await fetch(`${SOURCE}/${set}/${name}.svg`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "image/svg+xml" },
    });
    if (!response.ok) fail(404, `No icon called ${set}/${name}.`);
    const type = response.headers.get("content-type") || "";
    if (!type.includes("image/svg+xml"))
      fail(502, "That source returned a file that is not an SVG.");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) fail(413, "That icon is larger than 256 KB.");
    if (/<\s*script|javascript:|<\s*foreignObject/i.test(body.toString("utf8")))
      fail(422, "That icon contains scripting and was rejected.");
    return body;
  };

  // A limit stated in bytes helps nobody, and rounding a small one to whole
  // megabytes reports "0 MB", which reads as a bug.
  const readableSize = (bytes) =>
    bytes >= 1024 * 1024
      ? `${Math.round(bytes / (1024 * 1024))} MB`
      : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} bytes`;

  // What the workspace is already holding, not counting the row this write
  // replaces: re-saving an icon under the same name must not be refused for
  // space it is about to give back.
  // Bytes come from the shared store; the per-row columns are what rows saved
  // before this release still carry, and the object key is older still.
  const bytesFor = async (icon) => {
    if (icon.digest) {
      const { rows } = await db.query(
        "SELECT bytes FROM icon_blobs WHERE digest=$1",
        [icon.digest],
      );
      if (rows[0]) return rows[0].bytes;
    }
    return (
      icon.icon_data ||
      icon.svg_data ||
      (icon.s3_key ? await storage.read(icon.s3_key) : null)
    );
  };

  const libraryBytes = async (workspace, set, name) => {
    // Each distinct image is counted once however many names point at it, so
    // the ceiling measures what is actually stored rather than how often it
    // was referenced.
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(octet_length(blob.bytes)),0)::bigint AS used
         FROM (SELECT DISTINCT digest FROM icons
                WHERE workspace_id=$1 AND NOT (set_name=$2 AND name=$3)
                  AND digest IS NOT NULL) AS used_digests
         JOIN icon_blobs blob ON blob.digest = used_digests.digest`,
      [workspace, set, name],
    );
    return Number(rows[0].used);
  };

  const store = async (
    workspace,
    set,
    name,
    body,
    mime,
    meta,
    actor,
    category = "General",
    displayName = null,
  ) => {
    const used = await libraryBytes(workspace, set, name);
    if (used + body.length > MAX_WORKSPACE_LIBRARY_BYTES)
      fail(
        413,
        `This workspace's icon library is full (${readableSize(
          MAX_WORKSPACE_LIBRARY_BYTES,
        )}). Delete some icons before adding more.`,
      );
    // The image is named by what it contains, so the same logo added again —
    // under any name, by anyone — lands on the row that is already there.
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    // That held for the bytes, not for the library. Entries were kept apart by
    // name, so the same picture added twice under two names was two tiles, and
    // the library showed one image over and over — the thing a library exists
    // to stop. What an icon *is* decides: identical bytes are the same icon,
    // and the entry already there is returned instead of a second one made.
    // Anything genuinely different — a colour changed, a line moved — hashes
    // differently and is a new icon, which is the distinction worth keeping.
    const already = await db.query(
      `SELECT id,set_name,name,mime,s3_key,digest,category,display_name
         FROM icons
        WHERE digest=$1 AND (workspace_id=$2 OR shared)
        ORDER BY (workspace_id=$2) DESC, created_at ASC
        LIMIT 1`,
      [digest, workspace],
    );
    if (already.rows[0]) return { ...already.rows[0], existing: true };
    await db.query(
      `INSERT INTO icon_blobs(digest,bytes,mime) VALUES($1,$2,$3)
       ON CONFLICT (digest) DO NOTHING`,
      [digest, body, mime],
    );
    const { rows } = await db.query(
      `INSERT INTO icons(workspace_id,set_name,name,mime,s3_key,svg_data,icon_data,digest,source,license,created_by,category,display_name)
       VALUES($1,$2,$3,$4,NULL,NULL,NULL,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (workspace_id,set_name,name) DO UPDATE
       SET svg_data=NULL,icon_data=NULL,digest=EXCLUDED.digest,mime=EXCLUDED.mime,
           source=EXCLUDED.source,license=EXCLUDED.license,
           category=EXCLUDED.category,
           display_name=COALESCE(EXCLUDED.display_name,icons.display_name)
       RETURNING id,set_name,name,mime,s3_key,digest,category,display_name`,
      [
        workspace,
        set,
        name,
        mime,
        digest,
        meta.source,
        meta.license,
        actor,
        category,
        displayName,
      ],
    );
    return rows[0];
  };

  // Used by the drawing tools: returns the icon ready to embed in a scene.
  const iconData = async (workspace, reference) => {
    const ref = normal(reference);
    if (!REF.test(ref)) return null;
    const [set, name] = ref.split("/");
    // The library is shared, so an icon saved in another workspace counts.
    // Two workspaces may hold the same set/name, so the caller's own copy wins
    // and the oldest otherwise, which keeps the answer stable.
    const { rows } = await db.query(
      `SELECT * FROM icons
        WHERE (workspace_id=$1 OR shared) AND set_name=$2 AND name=$3
        ORDER BY (workspace_id=$1) DESC, created_at ASC
        LIMIT 1`,
      [workspace, set.toLowerCase(), name.toLowerCase()],
    );
    let icon = rows[0];
    if (!icon) {
      if (!(await settings()).fetch_enabled) return null;
      const body = await download(set.toLowerCase(), name.toLowerCase());
      icon = await store(
        workspace,
        set.toLowerCase(),
        name.toLowerCase(),
        body,
        "image/svg+xml",
        { source: `${SOURCE}/${set}/${name}.svg`, license: "see source" },
        null,
      );
    }
    const body = await bytesFor(icon);
    if (!body) return null;
    return {
      ref: `${icon.set_name}/${icon.name}`,
      mime: icon.mime,
      dataURL: `data:${icon.mime};base64,${body.toString("base64")}`,
    };
  };

  // The library this workspace can draw with, for matching by meaning.
  const libraryFor = async (workspace) => {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (COALESCE(digest, set_name||'/'||name))
              set_name,name,display_name,category
         FROM icons WHERE workspace_id=$1 OR shared
        ORDER BY COALESCE(digest, set_name||'/'||name),
                 (workspace_id=$1) DESC, created_at ASC`,
      [workspace],
    );
    return rows;
  };

  // Plain words in, icons out, best first. Used by the drawing tools so a
  // description can ask for "the queue" and still get a picture of Kafka.
  const matchIcons = async (workspace, query, limit = 8, hint = "") =>
    rankIcons(String(query || ""), await libraryFor(workspace), limit, hint);

  // Ask the icon source what it has for these words. Only the one host is ever
  // contacted, and only for a list of names; nothing is downloaded here.
  const searchSource = async (query) => {
    const response = await fetch(
      `${SOURCE}/search?query=${encodeURIComponent(query)}&limit=48`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) return [];
    const body = await response.json();
    return (Array.isArray(body.icons) ? body.icons : [])
      .map((entry) => normal(entry))
      .filter((ref) => REF.test(ref));
  };

  // The library did not have it, so go and find it. The same scoring decides
  // what the source offered, which is what stops a search for words that mean
  // nothing from dragging an unrelated picture into the drawing. What arrives
  // is saved in the library, so the next drawing needs no network at all.
  const fetchFromSource = async (workspace, wanted, hint, better_than = 0) => {
    if (!(await settings()).fetch_enabled) return null;
    const refs = await searchSource(wanted);
    if (!refs.length) return null;
    const preferred = refs.filter((ref) =>
      PREFERRED_SETS.includes(ref.split("/")[0]),
    );
    const rows = (preferred.length ? preferred : refs).map((ref) => ({
      set_name: ref.split("/")[0],
      name: ref.split("/")[1],
      display_name: null,
      // The set a source files an icon under says nothing about what the icon
      // is, so it is not allowed to count towards the match.
      category: "",
    }));
    // The source is asked for words, so it answers with whatever shares one.
    // Only an icon that is actually named what was asked for is worth
    // downloading, and only if it is named after more of it than whatever the
    // library was ready to offer; anything looser is a guess made on someone
    // else's index.
    const [best] = rankIcons(String(wanted), rows, 1, hint);
    if (!best || best.covers / best.of <= better_than) return null;
    const [set, name] = best.ref.split("/");
    const body = await download(set, name);
    const saved = await store(
      workspace,
      set,
      name,
      body,
      "image/svg+xml",
      { source: `${SOURCE}/${set}/${name}.svg`, license: "see source" },
      null,
      FETCHED_CATEGORY,
    );
    return iconData(workspace, `${saved.set_name}/${saved.name}`);
  };

  // One icon ready to embed, found by exact name or, failing that, by meaning.
  // The reference actually used is reported back, because a diagram that
  // quietly swapped one picture for another is worse than one that says so.
  const findIcon = async (workspace, wanted, hint = "") => {
    const asked = String(wanted || "").trim();
    if (!asked) return null;
    let words = asked;
    if (REF.test(normal(asked))) {
      const exact = await iconData(workspace, asked);
      if (exact) return { ...exact, matched: false };
      // An exact name that is not here: only the name part says what was
      // wanted. The set it named is no reason to reach for a different picture
      // out of the same set.
      words = normal(asked).split("/")[1].replace(/[._-]+/g, " ");
    }
    const [best] = await matchIcons(workspace, words, 1, hint);
    // A weak match is worse than no icon. Standing in for what was asked for
    // takes a real hit on the icon's own name or on a word that means the same;
    // sharing a set or a category is not enough.
    const usable = best && best.score >= MIN_MATCH ? best : null;
    // How much of what was asked for this library icon is actually named
    // after. All of it, and the search is over: an icon called what was asked
    // for is the answer. Short of that it is a stand-in, and a stand-in must
    // not beat the real logo sitting at the source — that is how a box
    // labelled Terraform ends up wearing Ansible's badge, because the two
    // mean the same thing, and how every AWS box ends up with Route 53's,
    // because they all begin with the word "aws".
    const covered = usable ? usable.covers / usable.of : 0;
    if (covered >= 1) {
      const art = await iconData(workspace, usable.ref);
      if (art) return { ...art, matched: true, asked };
    }
    // What is here is a stand-in at best, so look outside for something named
    // after more of what was asked. A drawing is better with the real logo
    // than with an empty box, and the source failing is not a reason for the
    // drawing to fail: the box is simply drawn plain.
    try {
      const found = await fetchFromSource(workspace, words, hint, covered);
      if (found) return { ...found, matched: true, fetched: true, asked };
    } catch {
      // fall through to whatever the library could offer
    }
    if (usable) {
      const art = await iconData(workspace, usable.ref);
      if (art) return { ...art, matched: true, asked };
    }
    return null;
  };

  app.get("/api/workspaces/:workspace/icons", auth, async (req, res) => {
    await permit(req.user, req.params.workspace, "drawing.read");
    const query = String(req.query.q || "")
      .trim()
      .slice(0, 80);
    const category = String(req.query.category || "")
      .trim()
      .slice(0, 40);
    const limit = Math.max(1, Math.min(300, Number(req.query.limit) || 120));
    const [{ rows }, categories] = await Promise.all([
      // One tile per picture. Duplicates that predate the rule are collapsed
      // here as well, so a library that already holds the same image twice
      // stops showing it twice. Rows from before the shared store have no
      // digest and fall back to their name, which is how they were told apart
      // before.
      db.query(
        `SELECT * FROM (
         SELECT DISTINCT ON (COALESCE(digest, set_name||'/'||name))
         set_name,name,mime,source,license,created_at,category,display_name
       FROM icons WHERE (workspace_id=$1 OR shared)
       AND ($2::text='' OR set_name ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%' OR display_name ILIKE '%'||$2||'%')
       AND ($3::text='' OR category=$3)
       ORDER BY COALESCE(digest, set_name||'/'||name),(workspace_id=$1) DESC,created_at ASC
       ) one_per_picture ORDER BY set_name,name LIMIT $4`,
        [req.params.workspace, query, category, limit],
      ),
      db.query(
        "SELECT DISTINCT category FROM icons WHERE (workspace_id=$1 OR shared) ORDER BY category",
        [req.params.workspace],
      ),
    ]);
    res.json({
      icons: rows,
      categories: categories.rows.map((row) => row.category),
    });
  });

  app.post("/api/workspaces/:workspace/icons", auth, async (req, res) => {
    const workspace = req.params.workspace;
    await permit(req.user, workspace, "drawing.edit");
    const { body, mime } = parseCanvasImage(req.body?.data_url);
    const displayName = displayNameValue(req.body?.display_name);
    if (!displayName) fail(400, "Icon name is required.");
    const category = categoryValue(req.body?.category);
    const icon = await store(
      workspace,
      "uploads",
      safeIconName(displayName),
      body,
      mime,
      { source: "canvas", license: null },
      req.user.id,
      category,
      displayName,
    );
    await audit(db, req.user.id, "icons.add_from_canvas", workspace);
    // 200 rather than 201 when nothing was created: the caller asked for this
    // picture to be in the library and it is, but it is not a new icon and
    // should not be reported as one.
    const existing = Boolean(icon.existing);
    res.status(existing ? 200 : 201).json({ icon, existing });
  });

  app.delete(
    "/api/workspaces/:workspace/icons/:set/:name",
    auth,
    async (req, res) => {
      // The library is shared, so removing an icon removes it for everyone —
      // which is what deleting a shared thing has to mean. Editing rights in
      // the workspace that holds it are what allow that.
      const reference = normal(`${req.params.set}/${req.params.name}`);
      if (!REF.test(reference)) fail(404, "Icon not found.");
      const [set, name] = reference.split("/");
      const { rows } = await db.query(
        `SELECT id,workspace_id,digest FROM icons
          WHERE (workspace_id=$1 OR shared) AND set_name=$2 AND name=$3
          ORDER BY (workspace_id=$1) DESC, created_at ASC
          LIMIT 1`,
        [req.params.workspace, set, name],
      );
      const icon = rows[0];
      if (!icon) fail(404, "Icon not found.");
      await permit(req.user, icon.workspace_id, "drawing.edit");
      await db.query("DELETE FROM icons WHERE id=$1", [icon.id]);
      // The image itself goes only when the last name pointing at it has gone,
      // or deleting one of two names for the same logo would break the other.
      if (icon.digest)
        await db.query(
          `DELETE FROM icon_blobs
            WHERE digest=$1
              AND NOT EXISTS (SELECT 1 FROM icons WHERE digest=$1)`,
          [icon.digest],
        );
      await audit(db, req.user.id, "icons.delete", icon.workspace_id);
      res.json({ ok: true });
    },
  );

  app.get(
    "/api/workspaces/:workspace/icons/:set/:name",
    auth,
    async (req, res) => {
      await permit(req.user, req.params.workspace, "drawing.read");
      const reference = normal(`${req.params.set}/${req.params.name}`);
      if (!REF.test(reference)) fail(404, "Icon not found.");
      const [set, name] = reference.split("/");
      const { rows } = await db.query(
        `SELECT mime,s3_key,svg_data,icon_data,digest FROM icons
         WHERE (workspace_id=$1 OR shared) AND set_name=$2 AND name=$3
         ORDER BY (workspace_id=$1) DESC, created_at ASC
         LIMIT 1`,
        [req.params.workspace, set, name],
      );
      const icon = rows[0];
      if (!icon) fail(404, "Icon not found.");
      const body = await bytesFor(icon);
      if (!body) fail(404, "Icon data not found.");
      res.set({
        "Content-Type": icon.mime,
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "X-Content-Type-Options": "nosniff",
      });
      res.send(body);
    },
  );

  // Search the icon source by words, so an admin never has to guess exact names.
  app.get("/api/admin/icons/search", auth, admin, async (req, res) => {
    const query = String(req.query.q || "")
      .trim()
      .slice(0, 60);
    if (!query) return res.json({ results: [] });
    const response = await fetch(
      `${SOURCE}/search?query=${encodeURIComponent(query)}&limit=48`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) fail(502, "The icon source is unavailable right now.");
    const body = await response.json();
    res.json({
      results: Array.isArray(body.icons) ? body.icons.slice(0, 48) : [],
    });
  });

  // Previews are proxied so the page can show them without reaching outside.
  app.get("/api/admin/icons/preview", auth, admin, async (req, res) => {
    const ref = normal(req.query.ref);
    if (!REF.test(ref)) fail(400, "Use the form set/name or set:name.");
    const [set, name] = ref.split("/");
    const body = await download(set, name);
    res.set({
      "Content-Type": "image/svg+xml",
      "Cache-Control": "private, max-age=86400",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.send(body);
  });

  app.get("/api/admin/icons", auth, admin, async (req, res) => {
    const workspace = req.query.workspace;
    if (!uuid(workspace)) fail(400, "Choose a workspace.");
    const { rows } = await db.query(
      "SELECT set_name,name,display_name,category,source,license,created_at FROM icons WHERE workspace_id=$1 ORDER BY category,COALESCE(display_name,name),set_name,name",
      [workspace],
    );
    const categories = await db.query(
      "SELECT DISTINCT category FROM icons WHERE workspace_id=$1 ORDER BY category",
      [workspace],
    );
    res.json({
      icons: rows,
      categories: categories.rows.map((row) => row.category),
      ...(await settings()),
    });
  });

  app.put(
    "/api/admin/icons/settings",
    auth,
    admin,
    recent,
    async (req, res) => {
      const enabled = req.body?.fetch_enabled === true;
      await db.query(
        `INSERT INTO app_settings(key,value) VALUES('icons',$1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb,updated_at=now(),updated_by=$2`,
        [JSON.stringify({ fetch_enabled: enabled }), req.user.id],
      );
      await audit(
        db,
        req.user.id,
        "icons.fetch." + (enabled ? "enable" : "disable"),
        null,
      );
      res.json({ fetch_enabled: enabled });
    },
  );

  // Pull a named set of icons into the library in one go.
  app.post("/api/admin/icons/import", auth, admin, recent, async (req, res) => {
    const workspace = req.body?.workspace_id;
    if (!uuid(workspace)) fail(400, "Choose a workspace.");
    const category = categoryValue(req.body?.category);
    const refs = Array.isArray(req.body?.icons) ? req.body.icons : [];
    if (!refs.length || refs.length > MAX_IMPORT)
      fail(400, `Import between 1 and ${MAX_IMPORT} icons at a time.`);
    const displayName =
      refs.length === 1 ? displayNameValue(req.body?.display_name) : null;
    const imported = [];
    const failed = [];
    for (const ref of refs) {
      if (!REF.test(normal(ref))) {
        failed.push({
          ref,
          error: "Use the form set/name, like logos/kubernetes.",
        });
        continue;
      }
      const [set, name] = normal(ref).split("/");
      try {
        const body = await download(set, name);
        imported.push(
          await store(
            workspace,
            set,
            name,
            body,
            "image/svg+xml",
            { source: `${SOURCE}/${set}/${name}.svg`, license: "CC0/see set" },
            req.user.id,
            category,
            displayName,
          ),
        );
      } catch (error) {
        failed.push({ ref, error: error.message });
      }
    }
    await audit(db, req.user.id, "icons.import", workspace);
    res.json({ imported: imported.length, failed, icons: imported });
  });

  return { iconData, findIcon, matchIcons, settings, REF };
}
