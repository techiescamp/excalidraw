import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createPool, DATABASE_LIMITS } from "../lib/database.js";
import { STORAGE_TIMEOUTS } from "../lib/storage-timeouts.js";
import { transaction } from "../lib/core.js";

// On 11 Nov 2026 the site froze with the machine idle. A save locked a
// drawing's row, then waited on the storage bucket, which never answered.
// Nothing had a time limit, so every later save of that drawing queued behind
// the lock holding a pooled connection, the pool ran dry, and every request
// that touched the database waited forever. These tests rebuild that morning
// on a real database and check each limit breaks its link of the chain.

const quiet = { error: () => {} };
const base = process.env.TEST_DATABASE_URL;
const needsDatabase = base
  ? {}
  : { skip: "Set TEST_DATABASE_URL to run against a real database." };

// A promise nobody resolves until told to: the bucket that stopped answering.
const stalled = () => {
  let answer;
  const promise = new Promise((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the limits production runs with", () => {
  // Read the note in lib/database.js before changing any of these.
  assert.equal(DATABASE_LIMITS.max, 10);
  assert.equal(DATABASE_LIMITS.connectionTimeoutMillis, 10_000);
  assert.equal(DATABASE_LIMITS.lock_timeout, 20_000);
  assert.equal(DATABASE_LIMITS.idle_in_transaction_session_timeout, 60_000);
  assert.equal(STORAGE_TIMEOUTS.connectionTimeout, 5_000);
  assert.equal(STORAGE_TIMEOUTS.requestTimeout, 30_000);
  // Without this the SDK only warns when requestTimeout passes, and keeps
  // waiting.
  assert.equal(STORAGE_TIMEOUTS.throwOnRequestTimeout, true);
  // Nothing caps how long a working query may run; only waiting is capped.
  assert.equal("statement_timeout" in DATABASE_LIMITS, false);
});

test("the morning it froze, replayed", needsDatabase, async (t) => {
  const setup = createPool(base, {}, quiet);
  const table = `wedge_${process.pid}_${Date.now()}`;
  await setup.query(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
  await setup.query(`INSERT INTO ${table} VALUES (1)`);
  t.after(async () => {
    await setup.query(`DROP TABLE IF EXISTS ${table}`);
    await setup.end();
  });
  const lockRow = (tx) =>
    tx.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`);

  await t.test("a save stuck on the bucket lets go of its lock", async () => {
    const pool = createPool(
      base,
      { idle_in_transaction_session_timeout: 1_000 },
      quiet,
    );
    try {
      const bucket = stalled();
      // Locks the row, then waits on a bucket that does not answer — the
      // save that started it.
      const stuck = transaction(pool, async (tx) => {
        await lockRow(tx);
        await bucket.promise;
        await tx.query("SELECT 1");
      });
      await sleep(200);

      // The next save of the same drawing. Before the fix this waited for as
      // long as the first one did, which was forever.
      const started = Date.now();
      await transaction(pool, lockRow);
      const waited = Date.now() - started;
      assert.ok(
        waited < 4_000,
        `the lock came free after ${waited}ms, not never`,
      );

      // The bucket finally answers. Its session was ended under it, so the
      // stuck save fails — loudly, instead of holding everything up.
      bucket.answer();
      await assert.rejects(stuck);

      // And the process is still here to serve the next request.
      const { rows } = await pool.query("SELECT 1 AS ok");
      assert.equal(rows[0].ok, 1);
    } finally {
      await pool.end();
    }
  });

  await t.test(
    "waiting behind somebody else's lock gives up, it does not hang",
    async () => {
      // With the idle limit off, this is lock_timeout on its own.
      const pool = createPool(
        base,
        { idle_in_transaction_session_timeout: 0, lock_timeout: 500 },
        quiet,
      );
      try {
        const bucket = stalled();
        const holder = transaction(pool, async (tx) => {
          await lockRow(tx);
          await bucket.promise;
        });
        await sleep(200);
        const started = Date.now();
        await assert.rejects(transaction(pool, lockRow), (error) => {
          // 55P03: lock_not_available — the database's own "gave up waiting".
          assert.equal(error.code, "55P03");
          return true;
        });
        assert.ok(Date.now() - started < 3_000);
        bucket.answer();
        await holder;
      } finally {
        await pool.end();
      }
    },
  );

  await t.test(
    "a pool with every connection taken says so, it does not hang",
    async () => {
      const pool = createPool(
        base,
        { max: 2, connectionTimeoutMillis: 300 },
        quiet,
      );
      const held = [await pool.connect(), await pool.connect()];
      try {
        const started = Date.now();
        await assert.rejects(pool.query("SELECT 1"), /timeout/i);
        assert.ok(
          Date.now() - started < 2_000,
          "it failed in a fraction of a second",
        );
      } finally {
        for (const client of held) client.release();
        await pool.end();
      }
    },
  );
});

// The same helper against a stand-in connection, for the cases a real database
// will not produce on demand.
const fakePool = ({ failOn = null } = {}) => {
  const client = new EventEmitter();
  client.sent = [];
  client.released = "not yet";
  client.query = async (sql) => {
    client.sent.push(sql);
    if (sql === failOn) throw new Error(`${sql} failed: connection is gone`);
    return { rows: [] };
  };
  client.release = (error) => {
    client.released = error;
  };
  return { client, connect: async () => client };
};

test("the transaction helper", async (t) => {
  await t.test(
    "the real error is the one thrown, not the rollback's",
    async () => {
      const pool = fakePool({ failOn: "ROLLBACK" });
      await assert.rejects(
        transaction(pool, async () => {
          throw new Error("the bucket did not answer");
        }),
        /the bucket did not answer/,
      );
      // The rollback failing means the session is dead: it is destroyed, not
      // lent to the next request.
      assert.ok(pool.client.released instanceof Error);
    },
  );

  await t.test("a refusal goes back to the pool as it is", async () => {
    const pool = fakePool();
    await assert.rejects(
      transaction(pool, async () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      }),
      /Forbidden/,
    );
    assert.deepEqual(pool.client.sent, ["BEGIN", "ROLLBACK"]);
    assert.equal(
      pool.client.released,
      undefined,
      "a healthy connection is kept",
    );
  });

  await t.test(
    "the database ending the session mid-transaction does not crash the API",
    async () => {
      const pool = fakePool();
      // The error arrives from the network, on a later turn of the event loop
      // — not from inside the transaction's own code, where a try/catch would
      // see it. With nobody listening it is an uncaught exception and the test
      // runner fails the whole file, which is what the API used to do.
      await assert.rejects(
        transaction(pool, async () => {
          await new Promise((resolve) =>
            setImmediate(() => {
              pool.client.emit(
                "error",
                new Error(
                  "terminating connection due to idle-in-transaction timeout",
                ),
              );
              resolve();
            }),
          );
          throw new Error("the next query failed");
        }),
        /the next query failed/,
      );
      assert.match(pool.client.released?.message, /idle-in-transaction/);
      assert.equal(
        pool.client.listenerCount("error"),
        0,
        "it stops listening once the connection is handed back",
      );
    },
  );

  await t.test("a clean transaction commits and is kept", async () => {
    const pool = fakePool();
    const result = await transaction(pool, async () => "saved");
    assert.equal(result, "saved");
    assert.deepEqual(pool.client.sent, ["BEGIN", "COMMIT"]);
    assert.equal(pool.client.released, undefined);
  });
});

test("a bucket that never answers is given up on", async () => {
  // A server that accepts the connection and then says nothing at all — the
  // bucket on the morning it froze.
  const silent = createServer(() => {});
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  const sockets = new Set();
  silent.on("connection", (socket) => sockets.add(socket));
  const client = new S3Client({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${silent.address().port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    // The same shape production passes, with a shorter wait so the test is
    // quick. What is under test is that the SDK honours it at all: by default
    // it would wait here forever.
    requestHandler: { ...STORAGE_TIMEOUTS, requestTimeout: 500 },
    maxAttempts: 1,
  });
  try {
    const started = Date.now();
    await assert.rejects(
      client.send(new GetObjectCommand({ Bucket: "b", Key: "scene.json" })),
    );
    const waited = Date.now() - started;
    assert.ok(waited < 3_000, `it gave up after ${waited}ms`);
  } finally {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});
