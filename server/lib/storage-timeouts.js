// How long a request to the storage bucket may wait.
//
// Saving a drawing writes to the bucket while it holds that drawing's row
// lock, so a bucket that stops answering holds the lock with it. The SDK waits
// forever by default, and on 11 Nov 2026 that is exactly what froze the site
// (see lib/database.js). These make a dead request fail instead: no connection
// inside five seconds, or thirty seconds with no data moving. A large upload
// that keeps sending is not cut off — only one that has stalled.
//
// `throwOnRequestTimeout` is the part that matters and the part that is easy
// to miss. Without it this SDK only prints a warning when requestTimeout
// passes, and carries on waiting — so the limit looks set and does nothing.
// test/database.test.js holds a request against a server that never answers
// to prove the request is actually abandoned.
export const STORAGE_TIMEOUTS = Object.freeze({
  connectionTimeout: 5_000,
  requestTimeout: 30_000,
  throwOnRequestTimeout: true,
});
