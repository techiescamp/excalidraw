import { test } from "node:test";
import assert from "node:assert/strict";
import { rankIcons, scoreIcon } from "../lib/icons.js";

// What a real library looks like: logo sets named after the product, uploads
// named by whoever added them, and categories that say what things are.
const library = [
  { set_name: "logos", name: "postgresql", display_name: "PostgreSQL", category: "Databases" },
  { set_name: "logos", name: "redis", display_name: "Redis", category: "Databases" },
  { set_name: "logos", name: "kafka", display_name: "Apache Kafka", category: "Messaging" },
  { set_name: "logos", name: "kubernetes", display_name: "Kubernetes", category: "Platform" },
  { set_name: "logos", name: "nginx", display_name: "NGINX", category: "Network" },
  { set_name: "logos", name: "aws-s3", display_name: "Amazon S3", category: "Storage" },
  { set_name: "logos", name: "prometheus", display_name: "Prometheus", category: "Monitoring" },
  { set_name: "uploads", name: "our-users-a1b2c3d4", display_name: "Customers", category: "People" },
  { set_name: "uploads", name: "redis-cluster-failover-9f8e", display_name: "Redis cluster failover", category: "Databases" },
];
const best = (query) => rankIcons(query, library)[0]?.ref;

test("icon matching by meaning", async (t) => {
  await t.test("finds an icon the asker named exactly", () => {
    assert.equal(best("logos/kafka"), "logos/kafka");
    assert.equal(best("logos:kafka"), "logos/kafka");
  });

  await t.test("finds the product when asked for what it is", () => {
    // Nothing in this library is called "database" or "queue".
    assert.equal(best("database"), "logos/postgresql");
    assert.equal(best("message queue"), "logos/kafka");
    assert.equal(best("cache"), "logos/redis");
    assert.equal(best("load balancer"), "logos/nginx");
    assert.equal(best("object storage"), "logos/aws-s3");
    assert.equal(best("metrics"), "logos/prometheus");
  });

  await t.test("finds the product when asked by another of its names", () => {
    assert.equal(best("postgres"), "logos/postgresql");
    assert.equal(best("k8s"), "logos/kubernetes");
    assert.equal(best("s3 bucket"), "logos/aws-s3");
  });

  await t.test("matches an upload by the name a person gave it", () => {
    assert.equal(best("users"), "uploads/our-users-a1b2c3d4");
    assert.equal(best("customer"), "uploads/our-users-a1b2c3d4");
  });

  await t.test("prefers the plainer of two icons that both answer", () => {
    assert.equal(best("redis"), "logos/redis");
  });

  await t.test("offers nothing rather than something unrelated", () => {
    assert.deepEqual(rankIcons("quarterly revenue", library), []);
    assert.deepEqual(rankIcons("", library), []);
    assert.equal(scoreIcon("x", library[0]), 0);
  });

  await t.test("uses the words around the request to settle a tie", () => {
    const monitoring = [
      { set_name: "logos", name: "grafana", display_name: "Grafana", category: "Monitoring" },
      { set_name: "logos", name: "prometheus", display_name: "Prometheus", category: "Monitoring" },
    ];
    // Both mean "metrics". The box says which one this is.
    assert.equal(rankIcons("metrics", monitoring, 1, "Prometheus")[0].ref, "logos/prometheus");
    assert.equal(rankIcons("metrics", monitoring, 1, "Grafana")[0].ref, "logos/grafana");
    // A hint that means nothing here changes nothing.
    assert.equal(
      rankIcons("metrics", monitoring, 1, "Orders")[0].ref,
      rankIcons("metrics", monitoring, 1)[0].ref,
    );
  });

  await t.test("returns the choices in order, with their labels", () => {
    const hits = rankIcons("database", library);
    assert.ok(hits.length >= 2, "a library with two databases offers both");
    assert.ok(hits[0].score >= hits[1].score, "best first");
    assert.equal(hits[0].name, "PostgreSQL");
    assert.equal(hits[0].category, "Databases");
  });
});
