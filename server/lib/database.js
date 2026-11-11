import pg from "pg";

// The limits every connection to the database is held to.
//
// They exist because of one morning (11 Nov 2026). A save took the row lock on
// a drawing, then waited on the storage bucket, which never answered. Nothing
// anywhere had a time limit, so that one transaction held the lock for as long
// as the process lived. Every later save of the same drawing queued behind it,
// each holding a pooled connection while it waited. All ten were gone inside
// a minute, and from then on every request that touched the database waited
// for a connection that would never come — the site sat on "loading" with the
// machine idle and nothing in any log.
//
// Each limit below breaks one link of that chain. None of them caps how long a
// working query may run: an export that reads a large workspace still gets as
// long as it needs. They only cap waiting.
export const DATABASE_LIMITS = Object.freeze({
  max: 10,
  // Waiting for a free connection. Past this the request fails with an error
  // the caller can see, instead of joining a queue that may never move.
  connectionTimeoutMillis: 10_000,
  // A connection nobody has used for this long is closed, so the pool does not
  // sit on ten idle sessions after a burst.
  idleTimeoutMillis: 30_000,
  // Waiting for a row lock somebody else holds. A save that has waited this
  // long for another save of the same drawing gives up and says so; the
  // editor's autosave tries again.
  lock_timeout: 20_000,
  // A transaction that has sent nothing for this long is ended by the database
  // itself, which releases every lock it held. This is the one that would have
  // ended the outage on its own: the stuck save sat "idle in transaction" for
  // twenty-six minutes. Long enough that a large drawing still uploads inside
  // it; short enough that a dead one costs a minute, not a morning.
  idle_in_transaction_session_timeout: 60_000,
});

export const poolOptions = (connectionString, overrides = {}) => ({
  connectionString,
  ...DATABASE_LIMITS,
  ...overrides,
});

/**
 * The pool the API uses.
 *
 * It also listens for errors on connections that are sitting idle in it. When
 * the database closes one of those — a restart, a network drop — node-postgres
 * reports it as an error on the pool, and with nobody listening that is an
 * uncaught exception that takes the whole API down. The connection is already
 * discarded by then; there is nothing to do but say so.
 */
export const createPool = (connectionString, overrides = {}, log = console) => {
  const pool = new pg.Pool(poolOptions(connectionString, overrides));
  pool.on("error", (error) =>
    log.error("Database connection dropped while idle:", error.message),
  );
  return pool;
};
