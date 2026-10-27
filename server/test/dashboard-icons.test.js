import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("icons are not managed from the administration page", async () => {
  const origin = "http://127.0.0.1:55441";
  const html = await readFile(
    new URL("../../dashboard/index.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: origin + "/admin/icons",
    runScripts: "outside-only",
  });
  const { window: win } = dom;
  const fetches = [];
  win.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  win.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new win.Event("close"));
  };
  win.BroadcastChannel = class {
    postMessage() {}
    close() {}
  };
  win.fetch = async (url) => {
    fetches.push(url);
    const request = new URL(url, origin);
    const response = (body) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    if (request.pathname === "/api/me") {
      return response({ id: "admin", username: "admin", is_superadmin: true });
    }
    if (request.pathname === "/api/workspaces") {
      return response([
        {
          id: "workspace-1",
          name: "Design workspace",
          permissions: { "collection.read": false },
        },
      ]);
    }
    if (request.pathname === "/api/admin/workspaces") {
      return response([]);
    }
    if (request.pathname === "/api/admin/icons") {
      return response({ icons: [], categories: [], fetch_enabled: false });
    }
    throw new Error(`Unexpected dashboard request: ${request.pathname}`);
  };

  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Dashboard state timed out: ${win.document.body.textContent}`);
  };

  try {
    const permissions = (
      await readFile(
        new URL("../../dashboard/permissions.js", import.meta.url),
        "utf8",
      )
    ).replaceAll("export ", "");
    const ui = (
      await readFile(new URL("../../dashboard/ui.js", import.meta.url), "utf8")
    ).replaceAll("export ", "");
    const app = (
      await readFile(new URL("../../dashboard/app.js", import.meta.url), "utf8")
    ).replace(/^import .*;\n/gm, "");
    win.eval(`(()=>{${permissions}\n${ui}\n${app}})()`);

    await waitFor(() => win.document.querySelector(".admin-nav"));
    assert.equal(
      win.document.querySelector('.admin-nav a[href="/admin/icons"]'),
      null,
    );
    assert.equal(win.document.querySelector("#icon-query"), null);
    assert.equal(
      fetches.some((url) => url.includes("/api/admin/icons")),
      false,
    );
  } finally {
    win.close();
  }
});
