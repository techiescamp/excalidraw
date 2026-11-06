import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "vitest";

// The API answers 403 "Invalid request origin." to any write that arrives
// without this header, so a request that forgets it fails silently from the
// user's side. Deleting an icon shipped that way once; this keeps the next
// write from doing it again.
const HEADER = "X-Excalidraw-Request";
const WRITES = /method:\s*"(POST|PUT|PATCH|DELETE)"/;
// Only our own workspace API asks for the header; the upstream excalidraw.com
// endpoints this app still talks to do not.
const OUR_API = /\$\{API\}|"\/api\//;

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "build" || entry.name === "node_modules"
        ? []
        : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe("writes to the workspace API", () => {
  it("all carry the header the API requires", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(__dirname, ".."))) {
      // Each piece after a `fetch(` holds one call's arguments.
      const calls = readFileSync(file, "utf8").split("fetch(").slice(1);
      for (const call of calls) {
        if (WRITES.test(call) && OUR_API.test(call) && !call.includes(HEADER)) {
          missing.push(`${file}: ${WRITES.exec(call)?.[0]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
