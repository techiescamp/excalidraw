import crypto from "node:crypto";
export const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
export const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
// One transaction on one pooled connection.
//
// Three things here are not obvious and each was learned the hard way:
//
// - While a connection is checked out, the pool stops listening for its
//   errors. If the database ends the session while `run` is waiting on
//   something else — the storage bucket, say — the connection emits 'error'
//   with nobody listening, and that is an uncaught exception that takes the
//   whole API down. So this listens for the life of the transaction.
//
// - When the connection is already dead, ROLLBACK fails too. Letting that
//   failure replace the real one hid every cause behind "Connection
//   terminated". The original error is the one that is thrown.
//
// - A connection whose session broke is handed back with the error, so the
//   pool destroys it rather than lending it to the next request. One that
//   merely refused something — a 403, a 409 — rolled back cleanly and goes
//   back to the pool as it is.
export const transaction = async (db, run) => {
  const client = await db.connect();
  let broken = null;
  const onError = (error) => {
    broken = broken || error;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = broken || rollbackError;
    }
    throw error;
  } finally {
    client.removeListener("error", onError);
    client.release(broken || undefined);
  }
};
export const audit = (db, actor, action, target, outcome = "success") =>
  db.query(
    "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'user',$3,$4)",
    [actor, action, target, { outcome }],
  );
export const username = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{3,32}$/.test(value.trim()))
    fail(
      400,
      "Username must be 3–32 ASCII letters, digits, periods, underscores or hyphens.",
    );
  return value.trim();
};
