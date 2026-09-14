const refreshTimers = new WeakMap();
// Workspace settings use the mounted page's document/window throughout.
export async function renderWorkspaceTransfer({
  host,
  state,
  api,
  escape,
  reauthenticate,
  kind,
  generation,
}) {
  const doc = host.ownerDocument,
    win = doc.defaultView;
  win.clearTimeout(refreshTimers.get(host));
  const workspace = state.workspace;
  if (!workspace) {
    host.textContent = "Choose a workspace first.";
    return;
  }
  const base = "/admin/workspaces/" + workspace.id;
  const previousScope =
    host.querySelector("[name=scope]:checked")?.value || "accessible";
  const previousMember = host.querySelector("[name=member_id]")?.value || "";
  const data = await api(base + "/transfers");
  if (generation !== state.generation) return;
  const title =
    kind === "workspace-export" ? "Workspace export" : "Workspace import";
  host.classList.add("transfer-page");
  host.innerHTML = `<h2 class="transfer-title">${title}</h2><div id="transfer-body"></div>`;
  const body = host.querySelector("#transfer-body");
  const showError = (error) => {
    const box = host.querySelector("[role=alert]");
    if (box) {
      box.textContent = error.message;
      box.hidden = false;
    }
  };
  if (kind === "workspace-export") {
    body.innerHTML = `<section class="transfer-section"><div><h3>Export workspace data</h3><p>You can export your workspace to a zip file. The zip file contains your drawings with their images, organized into collections.</p></div><div><div class="transfer-notice">The export process may take some time, depending on the size of your workspace. A download link will appear below when your export is ready.</div><form id="workspace-export-form"><fieldset><legend>Choose what to export</legend><div class="export-options"><label class="export-option"><input type="radio" name="scope" value="accessible" checked><span>Export accessible scenes<small>Shared scenes, and your own private scenes</small></span></label><div class="export-admin-options"><label class="export-option"><input type="radio" name="scope" value="all"><span>Export all scenes<small>Workspace and everyone's private scenes</small></span></label><label class="export-option"><input type="radio" name="scope" value="member"><span>Export team-member's private scenes<small>Private scenes of a specific member</small></span></label></div></div></fieldset><label id="export-member-label" hidden>Team member<select name="member_id"><option value="">Select a member</option>${data.members
      .map((m) => `<option value="${m.id}">${escape(m.username)}</option>`)
      .join(
        "",
      )}</select></label><p class="muted export-privacy" hidden>This includes another member's private drawings. The export is recorded in the Audit log.</p><p role="alert" class="error" hidden></p><button class="primary" type="submit">Export workspace</button><p class="transfer-limit">Up to 999 drawings and 100 MB per export. One export per hour.</p></form></div></section><section class="transfer-section"><div><h3>Workspace export history <span class="count">${
      data.history.length
    }</span></h3><p>View the history of your workspace exports. Download links are valid for 7 days.</p></div><div class="export-history"><table><thead><tr><th>Requested by</th><th>Type</th><th>Requested at</th><th><span class="sr-only">Status</span></th></tr></thead><tbody>${
      data.history.length
        ? data.history
            .map(
              (job) =>
                `<tr><td>${escape(
                  job.username,
                )}</td><td><span class="export-type">${escape(
                  job.scope,
                )}</span></td><td>${escape(
                  new win.Date(job.created_at).toLocaleString(),
                )}</td><td>${
                  new win.Date(job.expires_at) <= new win.Date()
                    ? "Expired"
                    : job.status === "ready"
                    ? job.own
                      ? `<a href="/api${base}/exports/${job.id}/download">Download</a>`
                      : "Ready"
                    : job.status === "failed"
                    ? `<span class="error" title="${escape(
                        job.error,
                      )}">Failed: ${escape(job.error)}</span>`
                    : job.status === "expired"
                    ? "Expired"
                    : '<span class="export-pending">Exporting…</span>'
                }</td></tr>`,
            )
            .join("")
        : '<tr><td colspan="4" class="muted">No exports yet.</td></tr>'
    }</tbody></table></div></section>`;
    const form = host.querySelector("form"),
      submit = form.querySelector("[type=submit]");
    const remaining = () =>
      Math.max(
        0,
        Math.ceil(
          (new win.Date(data.next_export_at).getTime() - Date.now()) / 60000,
        ),
      );
    const update = () => {
      const minutes = remaining();
      submit.disabled = minutes > 0;
      submit.textContent = minutes
        ? `Export again in ${minutes} minutes`
        : "Export workspace";
    };
    update();
    form.onchange = () => {
      const member = form.elements.scope.value === "member";
      host.querySelector("#export-member-label").hidden = !member;
      form.elements.member_id.required = member;
      host.querySelector(".export-privacy").hidden =
        form.elements.scope.value === "accessible";
    };
    form.elements.scope.value = previousScope;
    form.elements.member_id.value = previousMember;
    form.onchange();
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        if (!(await reauthenticate())) return;
        await api(base + "/exports", {
          method: "POST",
          body: {
            scope: form.elements.scope.value,
            member_id: form.elements.member_id.value || undefined,
          },
        });
        await renderWorkspaceTransfer({
          host,
          state,
          api,
          escape,
          reauthenticate,
          kind,
          generation,
        });
      } catch (error) {
        showError(error);
      } finally {
        if (form.isConnected) update();
      }
    };
    const poll = () =>
      win.setTimeout(
        async () => {
          if (!host.isConnected || generation !== state.generation) return;
          try {
            await renderWorkspaceTransfer({
              host,
              state,
              api,
              escape,
              reauthenticate,
              kind,
              generation,
            });
          } catch (error) {
            showError(error);
          }
        },
        data.history.some((j) => ["queued", "exporting"].includes(j.status))
          ? 3000
          : 60000,
      );
    refreshTimers.set(host, poll());
    return;
  }
  body.innerHTML = `<div class="import-empty"><svg class="import-plane" viewBox="0 0 420 160" fill="none" aria-hidden="true"><path d="M18 120C120 174 205 13 145 39S107 171 282 66" stroke="currentColor" stroke-width="2" stroke-dasharray="9 9"/><path d="m281 44 106-24-48 58-28-21-30-13Zm30 13 76-37-57 45m-19-8 2 24 17-16" stroke="currentColor" stroke-width="2"/></svg><h3>Import scenes and collections</h3><p>Import your existing Excalidraw scenes or ZIP archives to your workspace.<br>Scenes will be organized into collections automatically.</p><div class="import-actions"><button class="primary" id="select-folders">↑ &nbsp; Select folders</button><button id="select-files">↑ &nbsp; Select files & Zip archives</button><input id="import-folders" type="file" webkitdirectory multiple hidden><input id="import-files" type="file" accept=".excalidraw,.zip" multiple hidden></div><div class="import-divider"><span>or</span></div><p>Drag & drop files or folders anywhere on this page</p><label class="import-destination">Loose files go to<select id="import-destination"><option value="">Private</option>${state.collections
    .map((c) => `<option value="${c.id}">${escape(c.name)}</option>`)
    .join(
      "",
    )}</select></label><p class="transfer-limit">100 MB per upload · 25 MB per drawing · 1,000 archive entries maximum.<br>Private drawings in exported archives import into your Private area.</p><p role="alert" class="error" hidden></p><div id="import-progress" role="status" aria-live="polite"></div></div>`;
  let busy = false;
  const progress = host.querySelector("#import-progress");
  async function upload(files, request = win.crypto.randomUUID()) {
    if (busy || !files.length) return;
    if (files.length > 1000) {
      showError(new Error("Select up to 1,000 files."));
      return;
    }
    busy = true;
    const controls = host.querySelectorAll("button,input,select");
    controls.forEach((c) => (c.disabled = true));
    try {
      if (!(await reauthenticate())) return;
      const summary = { imported: 0, skipped: 0, errors: [] };
      let index = 0;
      for (const { file, path } of files) {
        progress.textContent = `Importing ${++index} of ${
          files.length
        }: ${path}`;
        if (!/\.(excalidraw|zip)$/i.test(file.name)) {
          summary.skipped++;
          continue;
        }
        if (file.size > 100 * 1024 * 1024) {
          summary.errors.push({ file: path, error: "Upload exceeds 100 MB." });
          continue;
        }
        const destination = host.querySelector("#import-destination").value;
        try {
          const response = await win.fetch(
            "/api" +
              base +
              "/imports" +
              (destination
                ? "?collection_id=" + encodeURIComponent(destination)
                : ""),
            {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "X-Excalidraw-Request": "1",
                "Idempotency-Key": request,
                "Content-Type": /\.zip$/i.test(file.name)
                  ? "application/zip"
                  : "application/x-excalidraw",
                "X-File-Path": encodeURIComponent(path),
              },
              body: file,
            },
          );
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Import failed.");
          summary.imported += result.imported;
          summary.skipped += result.skipped;
          summary.errors.push(...result.errors);
        } catch (error) {
          summary.errors.push({ file: path, error: error.message });
        }
      }
      progress.innerHTML = `<strong>Import complete</strong><p>${
        summary.imported
      } imported · ${summary.skipped} skipped · ${
        summary.errors.length
      } errors</p>${
        summary.errors.length
          ? `<details><summary>View errors</summary><ul>${summary.errors
              .map((e) => `<li>${escape(e.file)}: ${escape(e.error)}</li>`)
              .join("")}</ul></details>`
          : ""
      }<a href="/dashboard">View drawings</a>${
        summary.errors.length
          ? '<button id="retry-import">Retry failed import</button>'
          : ""
      }`;
      const retry = host.querySelector("#retry-import");
      if (retry) retry.onclick = () => void upload(files, request);
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      controls.forEach((c) => (c.disabled = false));
    }
  }
  for (const kind of ["folders", "files"]) {
    const input = host.querySelector("#import-" + kind);
    host.querySelector("#select-" + kind).onclick = () => input.click();
    input.onchange = () =>
      void upload(
        Array.from(input.files, (file) => ({
          file,
          path: file.webkitRelativePath || file.name,
        })),
      );
  }
  host.ondragover = (event) => {
    event.preventDefault();
    if (!busy) host.classList.add("import-dragging");
  };
  host.ondragleave = (event) => {
    if (!host.contains(event.relatedTarget))
      host.classList.remove("import-dragging");
  };
  host.ondrop = async (event) => {
    event.preventDefault();
    host.classList.remove("import-dragging");
    if (busy) return;
    const files = [];
    async function walk(entry) {
      if (files.length >= 1000) throw new Error("Select up to 1,000 files.");
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) =>
          entry.file(resolve, reject),
        );
        files.push({ file, path: entry.fullPath.replace(/^\//, "") });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((resolve, reject) =>
            reader.readEntries(resolve, reject),
          );
          for (const child of batch) await walk(child);
        } while (batch.length);
      }
    }
    try {
      const entries = Array.from(event.dataTransfer.items || [], (item) =>
        item.webkitGetAsEntry?.(),
      ).filter(Boolean);
      if (entries.length) {
        for (const entry of entries) await walk(entry);
      } else
        for (const file of event.dataTransfer.files)
          files.push({ file, path: file.name });
      await upload(files);
    } catch (error) {
      showError(error);
    }
  };
}
