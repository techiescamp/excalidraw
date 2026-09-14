import { renderWorkspaceTransfer } from "./workspace-transfer.js";
import { icon, relativeTime } from "./ui.js";
import { PERMISSIONS, effectivePermissions } from "./permissions.js";
const root = document.getElementById("shell");
const doc = root.ownerDocument,
  win = doc.defaultView;
const $ = (selector) => doc.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ]),
  );
const state = {
  me: null,
  workspaces: [],
  workspace: null,
  collections: [],
  scenes: [],
  generation: 0,
};
const guidance =
  "Use 8–128 characters. Spaces and Unicode are welcome. Avoid common or compromised passwords.";
const can = (key) => Boolean(state.workspace?.permissions[key]);
const params = () => new URLSearchParams(win.location.search);
const route = () => win.location.pathname;
const goto = (path, replace = false) => {
  win.history[replace ? "replaceState" : "pushState"]({}, "", path);
  return render();
};
const api = async (path, { body, method = "GET", key, ...options } = {}) => {
  let response;
  try {
    response = await win.fetch("/api" + path, {
      credentials: "same-origin",
      method,
      headers: {
        "X-Excalidraw-Request": "1",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...options,
    });
  } catch {
    throw new Error(
      "Cannot reach the server. Check your connection and try again.",
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Object.assign(new Error(result.error || "Request failed."), {
      status: response.status,
    });
    if (response.status === 401 && !path.startsWith("/auth/")) {
      state.me = null;
      state.scenes = [];
      state.collections = [];
      root.replaceChildren();
      await goto("/login", true);
    }
    throw error;
  }
  return result;
};
const button = (text, attrs = "") => `<button ${attrs}>${text}</button>`;
const input = (label, name, value = "", attrs = "") =>
  `<label>${label}<input name="${name}" value="${escape(
    value,
  )}" ${attrs}></label>`;
const password = (label, name, autocomplete = "new-password") =>
  `<label>${label}<span class="password-field"><input name="${name}" type="password" autocomplete="${autocomplete}" required ${
    autocomplete === "new-password" ? 'minlength="8" maxlength="128"' : ""
  }><button type="button" data-visibility="${name}" aria-label="Show ${label.toLowerCase()}">Show</button></span></label>`;
const errorBox = '<p class="error" role="alert" hidden></p>';
function formHandler(form, run, busy = "Saving…") {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("[type=submit]");
    if (submit.disabled) return;
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = busy;
    form.querySelector(".error").hidden = true;
    try {
      await run(Object.fromEntries(new win.FormData(form)), form);
    } catch (error) {
      const box = form.querySelector(".error");
      box.textContent = error.message;
      box.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
}
function modal(title, contents, submitText, onSubmit) {
  const dialog = $("#dialog");
  dialog.className = "";
  dialog.innerHTML = `<form><h2 id="dialog-title">${escape(
    title,
  )}</h2>${contents}${errorBox}<div class="modal-actions">${button(
    "Cancel",
    'type="button" data-close',
  )}${button(submitText, 'type="submit" class="primary"')}</div></form>`;
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  formHandler(dialog.querySelector("form"), async (values, form) => {
    await onSubmit(values, form);
    if (dialog.open && dialog.querySelector("form") === form) dialog.close();
  });
  if (!dialog.open) dialog.showModal();
  return dialog;
}
async function reauthenticate() {
  return new Promise((resolve) => {
    let completed = false;
    const d = modal(
      "Confirm your identity",
      password("Current password", "password", "current-password"),
      "Confirm",
      async (values) => {
        await api("/auth/reauthenticate", { method: "POST", body: values });
        completed = true;
        d.close();
        resolve(true);
      },
    );
    d.addEventListener(
      "close",
      () => {
        if (!completed) resolve(false);
      },
      { once: true },
    );
  });
}
function showLink(result) {
  const dialog = $("#dialog");
  dialog.innerHTML = `<h2 id="dialog-title">Private password link</h2><p>Share this link privately with the verified user. It is displayed only once.</p><p>Expires ${escape(
    new Date(result.expires_at).toLocaleString(),
  )}</p><label>Reset or setup link<textarea readonly rows="4">${escape(
    result.url,
  )}</textarea></label><div class="modal-actions">${button(
    "Copy reset link",
    "data-copy",
  )}${button("Done", "data-close")}</div><p role="status"></p>`;
  dialog.querySelector("[data-copy]").onclick = async () => {
    try {
      await win.navigator.clipboard.writeText(result.url);
      dialog.querySelector("[role=status]").textContent = "Copied.";
    } catch {
      dialog.querySelector("textarea").select();
      dialog.querySelector("[role=status]").textContent =
        "Select and copy the link.";
    }
  };
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
}
function authPage(kind) {
  const login = kind === "login",
    forgot = kind === "forgot-password",
    change = kind === "change-password",
    setup = kind === "set-password";
  const title = login
    ? "Sign in"
    : forgot
    ? "Forgot your password?"
    : change
    ? "Change password"
    : setup
    ? "Set your password"
    : "Reset password";
  root.innerHTML = `<main class="login"><form class="login-card"><a class="brand" href="/login">✎ Excalidraw</a><h1>${title}</h1><p class="muted">${
    login
      ? "Sign in to access your drawings and collections."
      : forgot
      ? "Enter your username to request help resetting your password."
      : guidance
  }</p>
 ${
   login || forgot
     ? input(
         "Username",
         "username",
         "",
         'autocomplete="username" required maxlength="32"',
       )
     : ""
 }
 ${
   login
     ? password("Password", "password", "current-password") +
       '<a href="/forgot-password">Forgot password?</a>'
     : ""
 }
 ${
   change
     ? password("Current password", "current_password", "current-password")
     : ""
 }
 ${
   !login && !forgot
     ? password("New password", "password") +
       password("Confirm password", "confirmation")
     : ""
 }
 ${errorBox}${button(
    login ? "Sign in" : forgot ? "Request password reset" : title,
    'class="primary" type="submit"',
  )}
 ${!login ? '<a href="/login">Back to sign in</a>' : ""}</form></main>`;
  const token = new URLSearchParams(win.location.hash.slice(1)).get("token");
  formHandler(
    $("form"),
    async (values) => {
      if (login) {
        await api("/auth/login", { method: "POST", body: values });
        await boot();
        await goto("/dashboard", true);
        return;
      }
      if (forgot) {
        const out = await api("/auth/forgot-password", {
          method: "POST",
          body: values,
        });
        $(
          ".login-card",
        ).innerHTML = `<h1>Request recorded</h1><p role="status">${escape(
          out.message,
        )}</p><a href="/login">Back to sign in</a>`;
        return;
      }
      if (values.password !== values.confirmation)
        throw new Error("Passwords do not match.");
      const out = await api(change ? "/me/password" : "/auth/reset-password", {
        method: "POST",
        body: change
          ? {
              current_password: values.current_password,
              new_password: values.password,
              confirmation: values.confirmation,
            }
          : { ...values, token, purpose: setup ? "setup" : "reset" },
      });
      state.me = null;
      win.history.replaceState({}, "", "/login");
      $(
        ".login-card",
      ).innerHTML = `<h1>Password updated</h1><p role="status">${escape(
        out.message,
      )}</p><a href="/login">Back to sign in</a>`;
    },
    login ? "Signing in…" : "Submitting…",
  );
  if (!login && !forgot && !change)
    api("/auth/check-token", {
      method: "POST",
      body: { token, purpose: setup ? "setup" : "reset" },
    }).catch((error) => {
      const card = $(".login-card");
      if (card) {
        card.innerHTML = `<h1>Link unavailable</h1><p role="alert">${escape(
          error.message,
        )}</p><a href="/forgot-password">Request a new link</a>`;
      }
    });
}
const viewPath = (changes = {}) => {
  const p = params();
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === "") p.delete(k);
    else p.set(k, v);
  }
  if (state.workspace) p.set("workspace", state.workspace.id);
  return `/dashboard?${p}`;
};
const collectionIcon = (c) =>
  c?.icon && c.icon !== "folder"
    ? `<span class="emoji">${escape(c.icon)}</span>`
    : icon("collection");
const avatar = (name) =>
  `<span class="avatar">${escape(
    String(name || "?")
      .slice(0, 1)
      .toUpperCase(),
  )}</span>`;
const navLink = (href, label, glyph, active) =>
  `<a href="${href}" ${active ? 'aria-current="page"' : ""}>${icon(
    glyph,
  )}<span>${label}</span></a>`;
const homePath = () => `/dashboard?workspace=${state.workspace?.id || ""}`;
const editorPath = (scene) =>
  `/editor?scene=${scene.id}&returnTo=${encodeURIComponent(
    win.location.pathname + win.location.search,
  )}`;
function notify(message, error = false) {
  let area = $("#notifications");
  if (!area) {
    area = doc.createElement("div");
    area.id = "notifications";
    area.setAttribute("aria-live", "polite");
    doc.body.append(area);
  }
  const toast = doc.createElement("div");
  toast.className = `toast ${error ? "error" : ""}`;
  toast.textContent = message;
  area.append(toast);
  win.setTimeout(() => toast.remove(), 6000);
}
const run = async (action) => {
  try {
    await action();
  } catch (error) {
    notify(error.message, true);
  }
};
let closeMenu;
function menu(anchor, items) {
  closeMenu?.();
  const el = doc.createElement("div");
  el.id = "context-menu";
  el.className = "context-menu";
  el.setAttribute("role", "menu");
  el.innerHTML = items
    .map(
      (item, i) =>
        `<button role="menuitem" data-index="${i}" class="${
          item.danger ? "danger" : ""
        }">${icon(item.icon || "arrow")}<span>${item.label}</span></button>`,
    )
    .join("");
  doc.body.append(el);
  const box = anchor.getBoundingClientRect();
  el.style.left = `${Math.min(box.left, win.innerWidth - 240)}px`;
  el.style.top = `${Math.max(
    8,
    Math.min(box.bottom + 6, win.innerHeight - el.offsetHeight - 8),
  )}px`;
  const close = () => {
    closeMenu = undefined;
    el.remove();
    doc.removeEventListener("pointerdown", outside);
    doc.removeEventListener("keydown", keys);
    if (anchor.isConnected) anchor.focus();
  };
  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const keys = (e) => {
    const buttons = [...el.querySelectorAll("button")];
    const index = buttons.indexOf(doc.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      buttons[
        e.key === "Home"
          ? 0
          : e.key === "End"
          ? buttons.length - 1
          : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
      ]?.focus();
    }
    if (e.key === "Tab") close();
  };
  el.onclick = (e) => {
    const b = e.target.closest("[data-index]");
    if (b) {
      const item = items[Number(b.dataset.index)];
      close();
      run(item.action);
    }
  };
  closeMenu = close;
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("keydown", keys);
  el.querySelector("button")?.focus();
}
function shell() {
  const p = params(),
    admin = route().startsWith("/admin/"),
    col = p.get("collection"),
    view = p.get("view") || "home";
  const work = state.workspace;
  root.innerHTML = `<div class="layout ${
    admin ? "admin-layout" : ""
  }"><aside class="sidebar"><button id="workspace-switch" class="workspace-switch">${avatar(
    work?.name,
  )}<strong>${escape(
    work?.name || "Your workspace",
  )}</strong><span class="switch-arrows">⌃<br>⌄</span></button>
 <button class="quick-search" id="quick-search">${icon(
   "search",
   17,
 )}<span>Quick search</span><kbd>⌘P</kbd></button>
 <nav class="primary-nav">${navLink(
   homePath(),
   "Dashboard",
   "dashboard",
   !admin && !col && view === "home",
 )}${
    state.me.is_superadmin
      ? navLink(
          "/admin/workspaces",
          "Workspace settings",
          "settings",
          route() === "/admin/workspaces",
        ) +
        navLink(
          "/admin/users",
          "Team members",
          "users",
          route() === "/admin/users",
        )
      : ""
  }${
    can("trash.read")
      ? navLink(
          viewPath({
            collection: null,
            view: "trash",
            search: null,
            page: null,
          }),
          "Trash",
          "trash",
          !admin && view === "trash",
        )
      : ""
  }</nav>
 <div class="section-head"><span>Collections</span>${
   can("collection.create")
     ? button(
         icon("plus", 17),
         'id="new-collection" class="icon-button primary" aria-label="Create collection"',
       )
     : ""
 }</div>
 <nav class="private-nav">${navLink(
   viewPath({ collection: null, view: "private", search: null, page: null }),
   "Private",
   "lock",
   !admin && view === "private",
 )}</nav>
 <nav id="collections" class="collection-nav">${state.collections
   .map(
     (c) =>
       `<div class="collection-row" data-drop="${c.id}"><a href="${viewPath({
         collection: c.id,
         view: null,
         search: null,
         page: null,
       })}" ${
         !admin && col === c.id ? 'aria-current="page"' : ""
       }>${collectionIcon(c)}<span>${escape(c.name)}</span></a>${
         can("collection.rename") || can("collection.delete")
           ? button(
               icon("more", 17),
               `data-col-menu="${
                 c.id
               }" class="icon-button" aria-label="Actions for ${escape(
                 c.name,
               )}"`,
             )
           : ""
       }</div>`,
   )
   .join("")}</nav>
 <nav class="sidebar-foot">${
   state.me.is_superadmin
     ? navLink("/admin/users", "Administration", "shield", admin)
     : ""
 }<button id="account-menu">${avatar(
    state.me.display_name || state.me.username,
  )}<strong>${escape(
    state.me.display_name || state.me.username,
  )}</strong>${icon("more", 18)}</button></nav></aside>
 <main class="main"><div class="mobile-top"><button id="mobile-nav" aria-label="Toggle navigation">${icon(
   "menu",
 )}</button><span>${escape(
    work?.name || "Workspace",
  )}</span></div><div id="page"><div class="loading-state" role="status"><span class="spinner"></span>Loading workspace…</div></div></main></div>`;
  $("#workspace-switch").onclick = (e) =>
    menu(
      e.currentTarget,
      state.workspaces.map((w) => ({
        label: escape(w.name),
        icon: "collection",
        action: () => goto(`/dashboard?workspace=${w.id}`),
      })),
    );
  $("#mobile-nav").onclick = () => {
    const expanded = $(".sidebar").classList.toggle("expanded");
    $("#mobile-nav").setAttribute("aria-expanded", String(expanded));
  };
  $("#account-menu").onclick = (e) =>
    menu(e.currentTarget, [
      {
        label: "Change password",
        icon: "lock",
        action: () => goto("/account/change-password"),
      },
      { label: "Appearance", icon: "moon", action: preferences },
      {
        label: "Sign out",
        icon: "logout",
        action: async () => {
          await api("/auth/logout", { method: "POST" });
          const channel = new win.BroadcastChannel("excalidraw-auth");
          channel.postMessage("logout");
          channel.close();
          state.me = null;
          await goto("/login", true);
        },
      },
    ]);
  $("#quick-search").onclick = quickSearch;
  $("#new-collection")?.addEventListener("click", () => collectionForm());
  doc.querySelectorAll("[data-col-menu]").forEach(
    (b) =>
      (b.onclick = () =>
        collectionMenu(
          state.collections.find((c) => c.id === b.dataset.colMenu),
          b,
        )),
  );
  doc.querySelectorAll("[data-drop]").forEach((el) => {
    el.ondragover = (e) => {
      if (can("drawing.edit")) {
        e.preventDefault();
        el.classList.add("drop-target");
      }
    };
    el.ondragleave = () => el.classList.remove("drop-target");
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      const scene = state.scenes.find(
        (s) => s.id === e.dataTransfer.getData("text/plain"),
      );
      if (scene) run(() => moveScene(scene, el.dataset.drop));
    };
  });
}
function preferences() {
  const d = modal(
    "Appearance",
    `<label>Theme<select name="theme"><option value="system">Use system setting</option><option value="light">Light</option><option value="dark">Dark</option></select></label>`,
    "Save",
    async (values) => {
      win.localStorage.setItem("workspace-theme", values.theme);
      doc.documentElement.dataset.theme = values.theme;
      notify("Appearance updated.");
    },
  );
  d.querySelector("select").value =
    win.localStorage.getItem("workspace-theme") || "light";
}
function collectionForm(col) {
  const key = win.crypto.randomUUID();
  const d = modal(
    col ? "Edit collection" : "Create collection",
    `<div class="collection-fields"><label>Icon<button type="button" id="icon-picker" class="collection-icon">${collectionIcon(
      col,
    )}</button><input type="hidden" name="icon" value="${escape(
      col?.icon || "folder",
    )}"></label>${input(
      "Collection name",
      "name",
      col?.name || "",
      "required autofocus",
    )}</div><div id="emoji-options" hidden></div>`,
    col ? "Edit collection" : "Create collection",
    async (values) => {
      if (!values.name.trim() || [...values.name.trim()].length > 80)
        throw new Error("Use a name of 1–80 characters.");
      const result = await api(
        col
          ? `/collections/${col.id}`
          : `/workspaces/${state.workspace.id}/collections`,
        {
          method: col ? "PATCH" : "POST",
          body: { name: values.name, icon: values.icon, version: col?.version },
          key,
        },
      );
      d.close();
      await goto(
        viewPath({
          collection: result.id,
          page: null,
          view: null,
          search: null,
        }),
      );
      notify(col ? "Collection updated." : "Collection created.");
    },
  );
  $("#icon-picker").onclick = () => {
    const options = $("#emoji-options");
    options.hidden = !options.hidden;
    options.innerHTML = [
      "folder",
      "📁",
      "🚀",
      "💡",
      "☸️",
      "🧪",
      "🎨",
      "📚",
      "⚙️",
      "📝",
      "🌐",
      "🧠",
      "📊",
      "💻",
      "⭐",
      "🎯",
    ]
      .map((v) =>
        button(
          v === "folder" ? icon("collection") : v,
          `type="button" data-emoji="${v}" aria-label="${
            v === "folder" ? "Default icon" : v
          }"`,
        ),
      )
      .join("");
    options.querySelectorAll("button").forEach(
      (b) =>
        (b.onclick = () => {
          d.querySelector("[name=icon]").value = b.dataset.emoji;
          $("#icon-picker").innerHTML = b.innerHTML;
          options.hidden = true;
        }),
    );
  };
  d.querySelector("[name=name]").focus();
}
function collectionMenu(col, anchor) {
  const actions = [];
  if (can("drawing.create"))
    actions.push({
      label: "Create scene",
      icon: "scene",
      action: () => newDrawing(undefined, col.id),
    });
  if (can("collection.rename"))
    actions.push({
      label: "Edit",
      icon: "edit",
      action: () => collectionForm(col),
    });
  if (can("collection.delete"))
    actions.push({
      label: "Move to trash",
      icon: "trash",
      danger: true,
      action: () =>
        modal(
          "Move collection to trash?",
          `<p><strong>${escape(
            col.name,
          )}</strong> will move to Trash. Its drawings remain available in All scenes. Restoring the collection restores its memberships.</p>`,
          "Move to trash",
          async () => {
            await api(`/collections/${col.id}`, { method: "DELETE" });
            $("#dialog").close();
            await goto(homePath());
            notify("Collection moved to Trash.");
          },
        ),
    });
  menu(anchor, actions);
}
let creating = false;
async function newDrawing(imported, collection = params().get("collection")) {
  if (creating) return;
  creating = true;
  try {
    const scene = await api("/scenes", {
      method: "POST",
      key: win.crypto.randomUUID(),
      body: {
        workspace_id: state.workspace.id,
        name: imported?.name || "Untitled scene",
        collection_id: collection,
        private: !collection && params().get("view") !== "all",
        ...(imported ? { scene: imported.scene } : {}),
      },
    });
    win.location.assign(editorPath(scene));
  } catch (error) {
    notify(error.message, true);
  } finally {
    creating = false;
  }
}
function importDrawing() {
  const file = doc.createElement("input");
  file.type = "file";
  file.accept = ".excalidraw,application/json";
  file.onchange = () =>
    run(async () => {
      if (!file.files[0]) return;
      const scene = JSON.parse(await file.files[0].text());
      await newDrawing({
        scene,
        name: file.files[0].name.replace(/\.excalidraw$/, ""),
      });
    });
  file.click();
}
async function moveScene(scene, destination) {
  await api(`/scenes/${scene.id}/move`, {
    method: "POST",
    body: {
      collection_id: destination === "private" ? null : destination,
      private: destination === "private",
      version: scene.metadata_version,
    },
  });
  $("#dialog").close();
  await render();
  notify("Scene moved.");
}
function destinationPicker(scene, duplicate = false) {
  const current = scene.private_owner_id ? "private" : scene.collections[0]?.id;
  const options = [
    { id: "private", name: "Private", icon: "🔒" },
    ...state.collections,
  ];
  const d = modal(
    duplicate ? "Duplicate scene" : "Move scene",
    `${
      duplicate
        ? input("Scene name", "name", `${scene.name} copy`, "required")
        : ""
    }<label>Target collection<input type="search" id="destination-search" placeholder="Search collections…" autofocus></label><div class="destination-list">${options
      .map(
        (c) =>
          `<label class="destination" data-name="${escape(
            c.name.toLowerCase(),
          )}"><input type="radio" name="collection" value="${c.id}" ${
            c.id === current ? "checked" : ""
          }>${
            c.id === "private" ? icon("lock") : collectionIcon(c)
          }<span>${escape(c.name)}</span>${
            c.id === current
              ? '<small class="badge success">current</small>'
              : ""
          }</label>`,
      )
      .join(
        "",
      )}</div><p class="keyboard-hint">Use ↑↓ to navigate, Tab to focus, Enter to confirm</p>`,
    duplicate ? "Duplicate scene" : "Move scene",
    async (values) => {
      if (!values.collection) throw new Error("Choose a target collection.");
      if (duplicate) {
        await api(`/scenes/${scene.id}/duplicate`, {
          method: "POST",
          key: win.crypto.randomUUID(),
          body: {
            name: values.name,
            collection_id:
              values.collection === "private" ? null : values.collection,
            private: values.collection === "private",
          },
        });
        d.close();
        await render();
        notify("Scene duplicated.");
      } else await moveScene(scene, values.collection);
    },
  );
  $("#destination-search").oninput = (e) =>
    d
      .querySelectorAll(".destination")
      .forEach(
        (el) =>
          (el.hidden = !el.dataset.name.includes(e.target.value.toLowerCase())),
      );
  d.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const items = [...d.querySelectorAll(".destination:not([hidden]) input")];
    const index = items.indexOf(doc.activeElement);
    const next =
      items[
        (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
      ];
    if (next) {
      next.checked = true;
      next.focus();
    }
  });
}
async function versionHistory(scene) {
  const history = await api(`/scenes/${scene.id}/versions`);
  const d = modal(
    "Version history",
    `<p class="muted">${escape(
      scene.name,
    )} · Latest 100 saved versions. Restoring keeps your current version in history.</p><div class="version-list">${
      history.items
        .map(
          (v) =>
            `<div class="settings-row"><div><strong>Version ${v.scene_version}${
              v.scene_version === history.current ? " · Current" : ""
            }</strong><small>${escape(
              new Date(v.created_at).toLocaleString(),
            )} · ${escape(v.username || "Former member")}</small></div>${
              can("drawing.edit") && v.scene_version !== history.current
                ? button("Restore", `type="button" data-version="${v.id}"`)
                : ""
            }</div>`,
        )
        .join("") || "<p>No saved versions yet.</p>"
    }</div>`,
    "Done",
    async () => {},
  );
  d.querySelectorAll("[data-version]").forEach(
    (b) =>
      (b.onclick = () => {
        modal(
          "Restore this version?",
          `<p>Your current drawing stays available in version history.</p>`,
          "Restore version",
          async () => {
            await api(
              `/scenes/${scene.id}/versions/${b.dataset.version}/restore`,
              { method: "POST", body: { version: history.current } },
            );
            $("#dialog").close();
            await render();
            notify("Version restored.");
          },
        );
      }),
  );
}
function sceneMenu(scene, anchor) {
  const actions = [
    {
      label: "Version history",
      icon: "clock",
      action: () => versionHistory(scene),
    },
  ];
  if (can("drawing.rename"))
    actions.push(
      {
        label: "Rename",
        icon: "edit",
        action: () =>
          modal(
            "Rename scene",
            input("Scene name", "name", scene.name, "required autofocus"),
            "Rename scene",
            async (values) => {
              await api(`/scenes/${scene.id}`, {
                method: "PATCH",
                body: { name: values.name, version: scene.metadata_version },
              });
              $("#dialog").close();
              await render();
            },
          ),
      },
      {
        label: scene.pinned ? "Unpin" : "Pin",
        icon: "pin",
        action: async () => {
          await api(`/scenes/${scene.id}`, {
            method: "PATCH",
            body: { pinned: !scene.pinned, version: scene.metadata_version },
          });
          await render();
        },
      },
    );
  if (can("drawing.duplicate"))
    actions.push({
      label: "Duplicate",
      icon: "copy",
      action: () => destinationPicker(scene, true),
    });
  if (can("drawing.edit") && can("collection.remove"))
    actions.push({
      label: "Move",
      icon: "arrow",
      action: () => destinationPicker(scene),
    });
  if (can("drawing.export"))
    actions.push({
      label: "Export .excalidraw",
      icon: "download",
      action: async () => {
        const payload = await api(`/scenes/${scene.id}/export`);
        const url = win.URL.createObjectURL(
          new win.Blob([JSON.stringify(payload)], { type: "application/json" }),
        );
        const a = doc.createElement("a");
        a.href = url;
        a.download = `${scene.name}.excalidraw`;
        a.click();
        win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
      },
    });
  if (can("drawing.trash"))
    actions.push({
      label: "Move to trash",
      icon: "trash",
      danger: true,
      action: () =>
        modal(
          "Move scene to trash?",
          `<p>You can restore <strong>${escape(
            scene.name,
          )}</strong> from Trash.</p>`,
          "Move to trash",
          async () => {
            await api(`/scenes/${scene.id}`, { method: "DELETE" });
            $("#dialog").close();
            await render();
            notify("Scene moved to Trash.");
          },
        ),
    });
  menu(anchor, actions);
}
function card(s, trash = false) {
  return `<article class="scene-card" data-scene="${s.id}" ${
    !trash && can("drawing.edit") ? 'draggable="true"' : ""
  }><label class="scene-select"><input type="checkbox" data-select="${
    s.id
  }" aria-label="Select ${escape(s.name)}"></label><a class="scene-preview" ${
    trash ? "" : `href="${editorPath(s)}"`
  } tabindex="${trash ? "-1" : "0"}">${
    s.thumb_s3_key
      ? `<img src="/api/scenes/${s.id}/thumbnail?v=${
          s.scene_version
        }" alt="${escape(s.name)}" loading="lazy">`
      : `<span class="preview-placeholder">${icon("scene", 46)}</span>`
  }<span class="preview-time">${trash ? "Deleted " : ""}${relativeTime(
    trash ? s.deleted_at : s.updated_at,
  )}</span>${
    s.pinned ? `<span class="pin">${icon("pin", 14)}</span>` : ""
  }</a><div class="scene-caption"><a ${
    trash ? "" : `href="${editorPath(s)}"`
  } title="${escape(s.name)}">${escape(s.name)}</a><small>${
    trash
      ? escape(s.collections.map((c) => c.name).join(", ") || "No collection")
      : `by ${escape(s.owner_name)}`
  }</small></div>${
    trash
      ? can("drawing.restore")
        ? button("Restore", `class="restore-scene" data-restore="${s.id}"`)
        : ""
      : button(
          icon("more", 18),
          `class="scene-overflow icon-button" data-menu="${
            s.id
          }" aria-label="Actions for ${escape(s.name)}"`,
        )
  }</article>`;
}
const selectedScenes = new Set();
function updateSelection() {
  doc
    .querySelectorAll("[data-select]")
    .forEach((c) => (c.checked = selectedScenes.has(c.dataset.select)));
  let bar = $("#selection-toolbar");
  if (!bar) {
    bar = doc.createElement("div");
    bar.id = "selection-toolbar";
    doc.body.append(bar);
  }
  bar.hidden = !selectedScenes.size;
  const trash = params().get("view") === "trash";
  bar.innerHTML = `<strong>${selectedScenes.size} selected</strong>${button(
    "Select page",
    "data-select-page",
  )}${button("Clear", "data-clear-selection")}${
    can(trash ? "drawing.restore" : "drawing.trash")
      ? button(
          trash ? "Restore" : "Move to trash",
          'data-bulk-action class="primary"',
        )
      : ""
  }`;
  bar.querySelector("[data-clear-selection]").onclick = () => {
    selectedScenes.clear();
    doc.querySelectorAll("[data-select]").forEach((c) => (c.checked = false));
    updateSelection();
  };
  bar.querySelector("[data-select-page]").onclick = () => {
    doc.querySelectorAll("[data-select]").forEach((c) => {
      c.checked = true;
      selectedScenes.add(c.dataset.select);
    });
    updateSelection();
  };
  bar.querySelector("[data-bulk-action]")?.addEventListener("click", () =>
    modal(
      trash ? "Restore selected scenes?" : "Move selected scenes to trash?",
      `<p>${selectedScenes.size} scenes selected. ${
        trash
          ? "Their collection memberships are preserved."
          : "You can restore them later from Trash."
      }</p>`,
      trash ? "Restore" : "Move to trash",
      async () => {
        await api("/scenes/bulk", {
          method: "POST",
          body: {
            ids: [...selectedScenes],
            action: trash ? "restore" : "trash",
          },
        });
        selectedScenes.clear();
        updateSelection();
        $("#dialog").close();
        await render();
        notify(trash ? "Scenes restored." : "Scenes moved to Trash.");
      },
    ),
  );
}
function bindCards() {
  doc.querySelectorAll("[data-select]").forEach((c) => {
    c.checked = selectedScenes.has(c.dataset.select);
    c.onchange = () => {
      if (c.checked) selectedScenes.add(c.dataset.select);
      else selectedScenes.delete(c.dataset.select);
      updateSelection();
    };
  });
  doc.querySelectorAll("[data-menu]").forEach(
    (b) =>
      (b.onclick = () =>
        sceneMenu(
          state.scenes.find((s) => s.id === b.dataset.menu),
          b,
        )),
  );
  doc.querySelectorAll("[data-scene]").forEach((el) => {
    el.ondragstart = (e) =>
      e.dataTransfer.setData("text/plain", el.dataset.scene);
    el.oncontextmenu = (e) => {
      const anchor = el.querySelector("[data-menu]");
      if (anchor) {
        e.preventDefault();
        sceneMenu(
          state.scenes.find((s) => s.id === el.dataset.scene),
          anchor,
        );
      }
    };
  });
  doc.querySelectorAll("[data-restore]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await api(`/scenes/${b.dataset.restore}/restore`, { method: "POST" });
          await render();
          notify("Scene restored.");
        })),
  );
}
function emptyState(title, description, action = "") {
  return `<div class="empty-state"><div class="empty-art">${icon(
    "collection",
    48,
  )}</div><h2>${title}</h2><p>${description}</p>${action}</div>`;
}
async function drawingsPage(generation) {
  const p = params(),
    col = state.collections.find((c) => c.id === p.get("collection")),
    view = p.get("view") || "home",
    trash = view === "trash";
  if (!col && !p.get("collection") && view === "home")
    return dashboardPage(generation);
  if (p.get("collection") && !col) {
    $("#page").innerHTML = emptyState(
      "Collection unavailable",
      "It may have been moved to Trash or your access has changed.",
      `<a class="primary button" href="${homePath()}">Back to dashboard</a>`,
    );
    return;
  }
  const query = new URLSearchParams({
    workspace: state.workspace.id,
    search: p.get("search") || "",
    sort: p.get("sort") || "title",
    page: p.get("page") || "0",
  });
  if (col) query.set("collection", col.id);
  if (trash) query.set("trashed", "1");
  if (view === "private") query.set("private", "1");
  if (view === "unorganized") query.set("unorganized", "1");
  const [result, deleted] = await Promise.all([
    api(`/scenes?${query}`),
    trash
      ? api(`/workspaces/${state.workspace.id}/trashed-collections`)
      : Promise.resolve([]),
  ]);
  if (state.generation !== generation) return;
  state.scenes = result.items;
  const title =
    col?.name ||
    (trash
      ? "Trash"
      : view === "private"
      ? "Private"
      : view === "unorganized"
      ? "Unorganized"
      : "All scenes");
  $("#page").innerHTML = `<header class="page-head"><div><h1>${icon(
    trash ? "trash" : view === "private" ? "lock" : "collection",
    26,
  )}${
    col
      ? button(
          escape(title),
          'class="inline-title" id="rename-heading" aria-label="Edit collection"',
        )
      : escape(title)
  }</h1>${
    view === "private"
      ? "<p>This is your private collection. No other workspace members can see it.</p><p>Move a scene to another collection to share it with workspace members.</p>"
      : trash
      ? `<p>${result.total} deleted scenes · Restore your work</p>`
      : ""
  }</div><label class="sort-control"><span class="sr-only">Sort scenes</span><select id="sort"><option value="title">Name ↕</option><option value="updated">Last modified</option><option value="created">Last created</option></select></label></header>
 ${
   !trash
     ? `<div class="creation-tiles">${
         can("drawing.import")
           ? button(
               `<span class="tile-icon">${icon(
                 "import",
               )}</span><span>Import scenes</span>${icon("plus", 17)}`,
               'id="import" class="creation-tile"',
             )
           : ""
       }${
         can("drawing.create")
           ? button(
               `<span class="tile-icon">${icon(
                 "scene",
               )}</span><span>Create scene</span>${icon("plus", 17)}`,
               'id="new-drawing" class="creation-tile"',
             )
           : ""
       }</div>`
     : ""
 }
 <div class="scene-filter">${icon(
   "search",
   16,
 )}<input type="search" name="search" aria-label="Search scenes" placeholder="Search scenes…" value="${escape(
    p.get("search") || "",
  )}"><span>${result.total} ${
    result.total === 1 ? "scene" : "scenes"
  }</span></div>
 <div id="scene-results"><div class="scene-grid">${result.items
   .map((s) => card(s, trash))
   .join("")}</div>${
    !result.items.length
      ? emptyState(
          p.get("search")
            ? "No matching scenes"
            : trash
            ? "Trash is empty"
            : "This collection is empty.",
          p.get("search")
            ? "Try a different name."
            : trash
            ? "Deleted scenes and collections will appear here."
            : "Let's change that! Create a scene or import an Excalidraw file.",
        )
      : ""
  }</div>
 ${
   deleted.length
     ? `<section class="trash-collections"><h2>Deleted collections</h2>${deleted
         .map(
           (c) =>
             `<div class="settings-row"><span>${collectionIcon(c)} ${escape(
               c.name,
             )}</span>${button(
               "Restore",
               `data-restore-collection="${c.id}"`,
             )}</div>`,
         )
         .join("")}</section>`
     : ""
 }
 <div class="pagination">${
   result.page > 0 ? button("Previous", 'id="prev"') : ""
 }${
    (result.page + 1) * result.limit < result.total
      ? button("Next scenes", 'id="next"')
      : ""
  }</div>`;
  $("#sort").value = p.get("sort") || "title";
  $("#sort").onchange = (e) =>
    goto(viewPath({ sort: e.target.value, page: null }));
  $("#rename-heading")?.addEventListener("click", () => {
    if (can("collection.rename")) collectionForm(col);
  });
  $("#new-drawing")?.addEventListener("click", () => newDrawing());
  $("#import")?.addEventListener("click", importDrawing);
  $("#prev")?.addEventListener("click", () =>
    goto(viewPath({ page: result.page - 1 })),
  );
  $("#next")?.addEventListener("click", () =>
    goto(viewPath({ page: result.page + 1 })),
  );
  // Refresh results only. The search input stays mounted so typing never loses focus.
  let timer,
    searchGeneration = 0;
  const search = $("[name=search]");
  search.oninput = () => {
    win.clearTimeout(timer);
    const n = ++searchGeneration;
    timer = win.setTimeout(
      () =>
        run(async () => {
          const q = new URLSearchParams(query);
          q.set("search", search.value);
          q.set("page", "0");
          const fresh = await api(`/scenes?${q}`);
          if (
            n !== searchGeneration ||
            !search.isConnected ||
            state.generation !== generation
          )
            return;
          win.history.replaceState(
            {},
            "",
            viewPath({ search: search.value, page: null }),
          );
          selectedScenes.clear();
          $("#selection-toolbar")?.remove();
          state.scenes = fresh.items;
          $("#scene-results").innerHTML = `<div class="scene-grid">${fresh.items
            .map((s) => card(s, trash))
            .join("")}</div>${
            !fresh.items.length
              ? emptyState("No matching scenes", "Try a different name.")
              : ""
          }`;
          $(".scene-filter span").textContent = `${fresh.total} ${
            fresh.total === 1 ? "scene" : "scenes"
          }`;
          $(".pagination").innerHTML =
            fresh.total > fresh.limit ? button("Next scenes", 'id="next"') : "";
          $("#next")?.addEventListener("click", () =>
            goto(viewPath({ page: 1 })),
          );
          bindCards();
        }),
      250,
    );
  };
  doc.querySelectorAll("[data-restore-collection]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await api(`/collections/${b.dataset.restoreCollection}/restore`, {
            method: "POST",
          });
          await render();
        })),
  );
  bindCards();
  const page = $("#page");
  page.ondragover = (e) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  page.ondrop = (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    run(async () => {
      const file = e.dataTransfer.files[0];
      await newDrawing({
        name: file.name.replace(/\.excalidraw$/, ""),
        scene: JSON.parse(await file.text()),
      });
    });
  };
}
async function dashboardPage(generation) {
  const base = `workspace=${state.workspace.id}&limit=6`;
  const [modified, visited, activity] = await Promise.all([
    api(`/scenes?${base}&mine=1&sort=updated`),
    api(`/scenes?${base}&sort=visited`),
    api(`/workspaces/${state.workspace.id}/activity`),
  ]);
  if (state.generation !== generation) return;
  state.scenes = [
    ...new Map(
      [...modified.items, ...visited.items].map((s) => [s.id, s]),
    ).values(),
  ];
  $(
    "#page",
  ).innerHTML = `<header class="page-head dashboard-heading"><div><h1>${icon(
    "dashboard",
    26,
  )}Dashboard</h1><p class="tip">${icon(
    "clock",
    14,
  )}Tip: Press <kbd>⌘P</kbd> to open Quick search.</p></div>${
    can("drawing.create")
      ? button(
          `${icon("scene", 17)}Start drawing`,
          'class="primary" id="start-drawing"',
        )
      : ""
  }</header>
 <section class="dashboard-section"><div class="section-title"><h2>Recently modified by you</h2><a href="${viewPath(
   { view: "all", sort: "updated" },
 )}">All scenes ${icon("arrow", 15)}</a></div>${
    modified.items.length
      ? `<div class="scene-grid">${modified.items
          .map((s) => card(s))
          .join("")}</div>`
      : emptyState(
          "Your ideas start here",
          "Create your first scene. Your recent work will appear here.",
        )
  }</section>
 <section class="dashboard-section"><h2>Recently visited by you</h2>${
   visited.items.length
     ? `<div class="scene-grid">${visited.items
         .map((s) => card(s))
         .join("")}</div>`
     : '<p class="quiet-empty">Scenes you open will appear here.</p>'
 }</section>
 <section class="dashboard-section"><h2>Recent Activity</h2><div class="activity-list">${
   activity
     .map(
       (a) =>
         `<a class="activity-row" href="${editorPath({
           id: a.scene_id,
         })}">${avatar(a.display_name || a.username)}<span><strong>${escape(
           a.display_name || a.username,
         )}</strong> ${escape(a.action)} <strong>${escape(
           a.name,
         )}</strong><small>${relativeTime(a.created_at)}</small></span>${icon(
           "arrow",
           16,
         )}</a>`,
     )
     .join("") ||
   '<p class="quiet-empty">Workspace activity will appear as you create and edit scenes.</p>'
 }</div></section>`;
  $("#start-drawing")?.addEventListener("click", () => newDrawing());
  bindCards();
}
async function quickSearch() {
  const d = modal(
    "Quick search",
    `<label class="sr-only" for="quick-query">Search workspace scenes</label><input id="quick-query" type="search" placeholder="Search scenes…" autofocus><div id="quick-results"><p class="muted">Start typing to find a scene.</p></div>`,
    "Close",
    async () => {},
  );
  d.classList.add("search-dialog");
  let timer,
    generation = 0;
  const input = $("#quick-query");
  input.focus();
  input.oninput = () => {
    win.clearTimeout(timer);
    const current = ++generation;
    timer = win.setTimeout(
      () =>
        run(async () => {
          const result = await api(
            `/scenes?workspace=${
              state.workspace.id
            }&search=${encodeURIComponent(input.value)}&limit=20`,
          );
          if (current !== generation || !input.isConnected) return;
          $("#quick-results").innerHTML =
            result.items
              .map(
                (s) =>
                  `<a class="search-result" href="${editorPath(s)}">${icon(
                    s.private_owner_id ? "lock" : "scene",
                  )}<span>${escape(s.name)}<small>${escape(
                    s.collections.map((c) => c.name).join(", ") ||
                      "Private / unorganized",
                  )}</small></span>${icon("arrow", 16)}</a>`,
              )
              .join("") || '<p class="quiet-empty">No scenes found.</p>';
        }),
      200,
    );
  };
  d.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const links = [input, ...d.querySelectorAll(".search-result")];
      const i = links.indexOf(doc.activeElement);
      links[
        (i + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length
      ].focus();
    }
  });
}
function adminNav() {
  return (
    '<nav class="admin-nav">' +
    [
      ["workspaces", "Workspace settings"],
      ["users", "Team members"],
      ["teams", "Teams & access"],
      ["reset-requests", "Password requests"],
      ["audit-log", "Audit log"],
      ["storage", "Storage"],
      ["workspace-export", "Workspace export"],
      ["workspace-import", "Workspace import"],
    ]
      .map(
        ([id, label]) =>
          `<a href="/admin/${id}" ${
            route() === "/admin/" + id ? 'aria-current="page"' : ""
          }>${label}</a>`,
      )
      .join("") +
    "</nav>"
  );
}
async function workspaceForm(workspace) {
  if (!(await reauthenticate())) return;
  modal(
    workspace ? "Rename workspace" : "Create workspace",
    input(
      "Workspace name",
      "name",
      workspace?.name || "",
      'required maxlength="80"',
    ),
    "Save",
    async (values) => {
      await api(
        workspace ? `/admin/workspaces/${workspace.id}` : "/admin/workspaces",
        { method: workspace ? "PATCH" : "POST", body: values },
      );
      $("#dialog").close();
      await render();
      notify("Workspace saved.");
    },
  );
}
async function teamForm(data, team) {
  if (!(await reauthenticate())) return;
  modal(
    team ? "Edit team" : "Create team",
    input("Team name", "name", team?.name || "", 'required maxlength="80"') +
      input("Color", "color", team?.color || "#6965db", 'type="color"') +
      `<h3>Members</h3><p class="muted">Administrators have access to all teams by default. Assign users to this workspace before adding them here.</p><div class="member-picker">${
        data.members
          .map(
            (m) =>
              `<label class="check"><input type="checkbox" name="member-${
                m.id
              }" ${team?.members.includes(m.id) ? "checked" : ""}>${escape(
                m.display_name || m.username,
              )} <small>@${escape(m.username)}</small></label>`,
          )
          .join("") || "<p>No assigned workspace members.</p>"
      }</div>`,
    "Save team",
    async (values) => {
      await api(
        `/admin/workspaces/${state.workspace.id}/teams${
          team ? "/" + team.id : ""
        }`,
        {
          method: team ? "PATCH" : "POST",
          body: {
            name: values.name,
            color: values.color,
            members: data.members
              .filter((m) => values["member-" + m.id])
              .map((m) => m.id),
            version: team?.version,
          },
        },
      );
      $("#dialog").close();
      await render();
      notify("Team saved.");
    },
  );
}
async function collectionAccessForm(data, col) {
  if (!(await reauthenticate())) return;
  const d = modal(
    "Collection access",
    `<p><strong>${escape(
      col.name,
    )}</strong></p><label class="check"><input type="checkbox" name="everyone" ${
      !col.team_restricted ? "checked" : ""
    }>All workspace members</label><p class="muted">Otherwise, only selected teams and administrators can access this collection. Existing private scenes remain private. Drawings with multiple collections remain accessible through their other collections.</p><div class="member-picker">${
      data.teams
        .map(
          (t) =>
            `<label class="check"><input type="checkbox" name="team-${t.id}" ${
              col.teams.includes(t.id) ? "checked" : ""
            }>${escape(t.name)}</label>`,
        )
        .join("") || "<p>Create a team first to restrict access.</p>"
    }</div>`,
    "Save access",
    async (values) => {
      await api(`/admin/collections/${col.id}/access`, {
        method: "PUT",
        body: {
          version: col.version,
          restricted: values.everyone !== "on",
          teams: data.teams
            .filter((t) => values["team-" + t.id])
            .map((t) => t.id),
        },
      });
      $("#dialog").close();
      await render();
      notify("Collection access updated.");
    },
  );
  const toggle = () =>
    d
      .querySelectorAll('[name^="team-"]')
      .forEach(
        (c) => (c.disabled = d.querySelector("[name=everyone]").checked),
      );
  d.querySelector("[name=everyone]").onchange = toggle;
  toggle();
}
async function teamsPage(generation) {
  if (!state.workspace) {
    $("#admin-content").textContent = "Create a workspace first.";
    return;
  }
  const data = await api(`/admin/workspaces/${state.workspace.id}/teams`);
  if (generation !== state.generation) return;
  $(
    "#admin-content",
  ).innerHTML = `<div class="section-title"><div><h2>Teams & collection access</h2><p class="muted">${escape(
    state.workspace.name,
  )} · Organize members and control shared collections.</p></div>${button(
    "Create team",
    'class="primary" id="create-team"',
  )}</div><div class="team-grid">${
    data.teams
      .map(
        (t) =>
          `<button class="team-card" data-team="${
            t.id
          }"><span class="team-dot" style="background:${escape(
            t.color,
          )}"></span><strong>${escape(t.name)}</strong><small>${
            t.members.length
          } members + administrators</small>${icon("edit", 15)}</button>`,
      )
      .join("") ||
    '<p class="quiet-empty">Create a team to organize workspace members.</p>'
  }</div><h2>Collections</h2><label>Filter collections<input type="search" id="access-filter" placeholder="Search collections…"></label><div>${
    data.collections
      .map(
        (c) =>
          `<div class="settings-row" data-access-row="${escape(
            c.name.toLowerCase(),
          )}"><div><strong>${escape(c.name)}</strong><small>${
            c.team_restricted
              ? escape(
                  data.teams
                    .filter((t) => c.teams.includes(t.id))
                    .map((t) => t.name)
                    .join(", ") || "Administrators only",
                )
              : "All workspace members"
          }</small></div>${button(
            "Manage access",
            `data-access="${c.id}"`,
          )}</div>`,
      )
      .join("") ||
    '<p class="quiet-empty">Create a collection to manage its access.</p>'
  }</div>`;
  $("#create-team").onclick = () => run(() => teamForm(data));
  doc.querySelectorAll("[data-team]").forEach(
    (b) =>
      (b.onclick = () =>
        run(() =>
          teamForm(
            data,
            data.teams.find((t) => t.id === b.dataset.team),
          ),
        )),
  );
  doc.querySelectorAll("[data-access]").forEach(
    (b) =>
      (b.onclick = () =>
        run(() =>
          collectionAccessForm(
            data,
            data.collections.find((c) => c.id === b.dataset.access),
          ),
        )),
  );
  $("#access-filter").oninput = (e) =>
    doc
      .querySelectorAll("[data-access-row]")
      .forEach(
        (r) =>
          (r.hidden = !r.dataset.accessRow.includes(
            e.target.value.toLowerCase(),
          )),
      );
}
async function deleteUser(user) {
  if (!(await reauthenticate())) return;
  modal(
    "Delete user?",
    `<p><strong>${escape(
      user.username,
    )}</strong> will be removed and can no longer sign in.</p><p>Their drawings, images and collections are kept. Anything they owned, including private drawings, moves to you.</p><p>This cannot be undone.</p>`,
    "Delete user",
    async () => {
      await api(`/admin/users/${user.id}`, { method: "DELETE" });
      $("#dialog").close();
      await render();
      notify(`${user.username} was deleted. Their content was kept.`);
    },
  );
}
async function userForm(user) {
  if (!(await reauthenticate())) return;
  const content =
    input(
      "Username",
      "username",
      user?.username || "",
      'required pattern="[A-Za-z0-9_.-]{3,32}" autocomplete="off"',
    ) +
    input(
      "Display name (optional)",
      "display_name",
      user?.display_name || "",
      'maxlength="120"',
    ) +
    `<label class="check"><input type="checkbox" name="is_superadmin" ${
      user?.is_superadmin ? "checked" : ""
    }>Administrator — access to all application workspaces</label><label class="check"><input type="checkbox" name="confirm_global_admin">I confirm global administrator access when promoting this account</label>${
      user
        ? `<label class="check"><input type="checkbox" name="is_active" ${
            user.is_active ? "checked" : ""
          }>Account active</label>`
        : ""
    }<h3>Workspace assignments and permissions</h3><p>Overrides apply to all eligible resources in each assigned workspace. Administration cannot be granted by an override.</p>` +
    state.workspaces
      .map((w) => {
        const assigned = user?.assignments.find((a) => a.workspace_id === w.id);
        return `<fieldset data-workspace="${w.id}"><legend>${escape(
          w.name,
        )}</legend><label class="check"><input type="checkbox" name="assigned-${
          w.id
        }" ${
          assigned ? "checked" : ""
        }>Assigned</label><label>Role<select name="role-${
          w.id
        }"><option value="editor" ${
          assigned?.role === "editor" ? "selected" : ""
        }>Editor</option><option value="viewer" ${
          assigned?.role === "viewer" ? "selected" : ""
        }>Viewer</option></select></label><details><summary>Specific permissions · Inherit / Allow / Deny</summary><div class="permission-grid">${Object.entries(
          PERMISSIONS,
        )
          .map(
            ([key, [label, deps]]) =>
              `<label>${label}<small>${
                deps.length ? "Requires " + deps.join(", ") : ""
              }</small><select name="perm-${
                w.id
              }-${key}" data-permission="${key}"><option value="inherit">Inherit</option><option value="allow" ${
                assigned?.overrides[key] === "allow" ? "selected" : ""
              }>Allow</option><option value="deny" ${
                assigned?.overrides[key] === "deny" ? "selected" : ""
              }>Deny</option></select><span data-effective="${key}"></span></label>`,
          )
          .join("")}</div></details></fieldset>`;
      })
      .join("");
  let link;
  const d = modal(
    user ? "Edit user" : "Create user",
    content,
    "Save",
    async (values) => {
      const assignments = state.workspaces
        .filter((w) => values[`assigned-${w.id}`])
        .map((w) => ({
          workspace_id: w.id,
          role: values[`role-${w.id}`],
          overrides: Object.fromEntries(
            Object.keys(PERMISSIONS)
              .filter((k) => values[`perm-${w.id}-${k}`] !== "inherit")
              .map((k) => [k, values[`perm-${w.id}-${k}`]]),
          ),
        }));
      const body = {
        username: values.username,
        display_name: values.display_name,
        is_superadmin: values.is_superadmin === "on",
        confirm_global_admin: values.confirm_global_admin === "on",
        is_active: values.is_active === "on",
        assignments,
      };
      const result = await api(
        user ? `/admin/users/${user.id}` : "/admin/users",
        { method: user ? "PATCH" : "POST", body },
      );
      d.close();
      if (result.url) link = result;
      await render();
      if (link) showLink(link);
    },
  );
  const update = () =>
    d.querySelectorAll("[data-workspace]").forEach((field) => {
      const w = field.dataset.workspace;
      const overrides = Object.fromEntries(
        [...field.querySelectorAll("[data-permission]")]
          .filter((s) => s.value !== "inherit")
          .map((s) => [s.dataset.permission, s.value]),
      );
      const effective = effectivePermissions(
        field.querySelector(`[name="role-${w}"]`).value,
        overrides,
      );
      field
        .querySelectorAll("[data-effective]")
        .forEach(
          (s) =>
            (s.textContent = effective[s.dataset.effective]
              ? "Allowed"
              : "Denied (check dependencies if explicitly allowed)"),
        );
    });
  d.addEventListener("change", update);
  update();
}
async function issueLink(userId) {
  if (!(await reauthenticate())) return;
  let result;
  const d = modal(
    "Verify identity before issuing a link",
    '<p>Verify the user’s identity through an established channel outside the anonymous request form. Share the generated link privately.</p><label class="check"><input type="checkbox" name="verified" required>I have verified this user’s identity.</label>',
    "Issue private link",
    async () => {
      result = await api(`/admin/users/${userId}/password-link`, {
        method: "POST",
        body: { identity_verified: true },
      });
      d.close();
      showLink(result);
    },
  );
}
async function adminPage(generation) {
  if (!state.me.is_superadmin) {
    $("#page").innerHTML = "<h1>Access denied</h1>";
    return;
  }
  const p = params(),
    page = Math.max(0, Number(p.get("page")) || 0),
    name = route().split("/").pop();
  $(
    "#page",
  ).innerHTML = `<h1>Administration</h1>${adminNav()}<div id="admin-content"></div>`;
  if (["workspace-export", "workspace-import"].includes(name)) {
    $(".layout").classList.add("transfer-layout");
    $("#page").innerHTML = '<div id="admin-content"></div>';
    const sidebar = $(".sidebar");
    sidebar.querySelector(".primary-nav").innerHTML =
      '<h2 class="settings-nav-title">Workspace Settings</h2>' +
      [
        ["workspaces", "Settings", "settings"],
        ["users", "Members", "users"],
        ["teams", "Teams & Collections", "collection"],
        ["reset-requests", "Password requests", "lock"],
        ["storage", "Storage", "storage"],
        ["workspace-export", "Workspace export", "download"],
        ["workspace-import", "Workspace import", "import"],
        ["audit-log", "Logs", "scene"],
      ]
        .map(([id, label, glyph]) =>
          navLink("/admin/" + id, label, glyph, name === id),
        )
        .join("") +
      navLink(homePath(), "Dashboard", "dashboard", false);
    for (const selector of [".section-head", ".private-nav", ".collection-nav"])
      sidebar.querySelector(selector).hidden = true;
    return renderWorkspaceTransfer({
      host: $("#admin-content"),
      state,
      api,
      escape,
      reauthenticate,
      kind: name,
      generation,
    });
  }
  if (name === "teams") return teamsPage(generation);
  if (name === "workspaces") {
    const rows = await api("/admin/workspaces");
    if (generation !== state.generation) return;
    $(
      "#admin-content",
    ).innerHTML = `<div class="section-title"><div><h2>Workspaces</h2><p class="muted">Organize your team's drawings and collections.</p></div>${button(
      "Create workspace",
      'class="primary" id="create-workspace"',
    )}</div>${rows
      .map(
        (w) =>
          `<div class="settings-row"><div><strong>${escape(
            w.name,
          )}</strong><small>${w.members} assigned members · ${
            w.collections
          } collections · ${w.scenes} scenes</small></div>${button(
            "Rename",
            `data-workspace-edit="${w.id}"`,
          )}</div>`,
      )
      .join("")}`;
    $("#create-workspace").onclick = () => run(() => workspaceForm());
    doc
      .querySelectorAll("[data-workspace-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            run(() =>
              workspaceForm(rows.find((w) => w.id === b.dataset.workspaceEdit)),
            )),
      );
    return;
  } else if (name === "users") {
    const result = await api(
      `/admin/users?page=${page}&search=${encodeURIComponent(
        p.get("search") || "",
      )}`,
    );
    if (generation !== state.generation) return;
    $("#admin-content").innerHTML = `<div class="toolbar">${input(
      "Search users",
      "user-search",
      p.get("search") || "",
      'type="search"',
    )}${button("Search", 'id="search-users"')}${button(
      "Create user",
      'id="create-user" class="primary"',
    )}</div><div class="table-scroll"><table><thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Status</th><th>Workspaces</th><th>Last login</th><th>Actions</th></tr></thead><tbody>${result.items
      .map(
        (u) =>
          `<tr><td>${escape(u.username)}</td><td>${escape(
            u.display_name,
          )}</td><td>${
            u.is_superadmin
              ? "Administrator"
              : u.assignments.map((a) => escape(a.role)).join(", ") ||
                "Unassigned"
          }</td><td>${
            !u.is_active
              ? "Inactive"
              : u.pending_setup
              ? "Pending setup"
              : "Active"
          }</td><td>${u.assignments
            .map((a) =>
              escape(
                state.workspaces.find((w) => w.id === a.workspace_id)?.name ||
                  a.workspace_id,
              ),
            )
            .join(", ")}</td><td>${
            u.last_login_at
              ? escape(new Date(u.last_login_at).toLocaleString())
              : "Never"
          }</td><td>${button("Edit", `data-edit-user="${u.id}"`)}${button(
            u.pending_setup ? "Regenerate setup link" : "Issue reset link",
            `data-issue="${u.id}"`,
          )}${
            u.id === state.me.id
              ? ""
              : button("Delete", `class="danger" data-delete-user="${u.id}"`)
          }</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
    $("#create-user").onclick = () => userForm();
    $("#search-users").onclick = () =>
      goto(
        `/admin/users?search=${encodeURIComponent(
          $("[name=user-search]").value,
        )}`,
      );
    doc
      .querySelectorAll("[data-edit-user]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            userForm(result.items.find((u) => u.id === b.dataset.editUser))),
      );
    doc
      .querySelectorAll("[data-delete-user]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            deleteUser(
              result.items.find((u) => u.id === b.dataset.deleteUser),
            )),
      );
  } else if (name === "reset-requests") {
    const rows = await api(
      `/admin/reset-requests?page=${page}&status=${p.get("status") || ""}`,
    );
    if (generation !== state.generation) return;
    $(
      "#admin-content",
    ).innerHTML = `<label>Status<select id="status"><option value="">All</option><option>pending</option><option>resolved</option><option>rejected</option></select></label><table><thead><tr><th>User</th><th>Requested</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr><td>${escape(r.username)}</td><td>${escape(
            new Date(r.created_at).toLocaleString(),
          )}</td><td>${r.status}</td><td>${
            r.status === "pending"
              ? button("Issue reset link", `data-issue="${r.user_id}"`) +
                button("Reject", `data-reject="${r.id}"`)
              : ""
          }</td></tr>`,
      )
      .join("")}</tbody></table>`;
    $("#status").value = p.get("status") || "";
    $("#status").onchange = (e) =>
      goto(`/admin/reset-requests?status=${e.target.value}`);
    doc.querySelectorAll("[data-reject]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!(await reauthenticate())) return;
          await api(`/admin/reset-requests/${b.dataset.reject}/reject`, {
            method: "POST",
          });
          await render();
        }),
    );
  } else if (name === "storage") {
    const cfg = await api("/admin/storage");
    if (generation !== state.generation) return;
    $(
      "#admin-content",
    ).innerHTML = `<h2>Object storage</h2><p>Current backend: ${escape(
      cfg.driver,
    )}. Existing local files can be copied after configuring your bucket.</p><form id="storage-form">${input(
      "Bucket",
      "bucket",
      cfg.bucket,
      "required",
    )}${input("Region", "region", cfg.region, "required")}${input(
      "Endpoint (optional)",
      "endpoint",
      cfg.endpoint,
      'type="url"',
    )}${input("Access key ID", "keyId", cfg.keyId, "required")}${input(
      cfg.hasSecret
        ? "Secret access key (leave blank to retain)"
        : "Secret access key",
      "secret",
      "",
      'type="password" autocomplete="off"',
    )}<label class="check"><input type="checkbox" name="forcePathStyle" ${
      cfg.forcePathStyle ? "checked" : ""
    }>Use path-style URLs</label>${errorBox}${button(
      "Save storage configuration",
      'type="submit" class="primary"',
    )}</form><p id="storage-result" role="status"></p>${button(
      "Copy local files to object storage",
      'id="migrate-storage"',
    )}`;
    formHandler($("#storage-form"), async (values) => {
      if (!(await reauthenticate())) return;
      await api("/admin/storage", {
        method: "PUT",
        body: { ...values, forcePathStyle: values.forcePathStyle === "on" },
      });
      $("[name=secret]").value = "";
      $("#storage-result").textContent = "Storage configuration saved.";
    });
    $("#migrate-storage").onclick = async () => {
      if (!(await reauthenticate())) return;
      try {
        const result = await api("/admin/storage/migrate", { method: "POST" });
        $(
          "#storage-result",
        ).textContent = `Copied ${result.copied} of ${result.total} files; ${result.failed.length} failed.`;
      } catch (error) {
        $("#storage-result").textContent = error.message;
      }
    };
    return;
  } else {
    const rows = await api(
      `/admin/audit-log?page=${page}&action=${encodeURIComponent(
        p.get("action") || "",
      )}&outcome=${encodeURIComponent(p.get("outcome") || "")}`,
    );
    if (generation !== state.generation) return;
    $("#admin-content").innerHTML = `<div class="toolbar">${input(
      "Filter action",
      "audit-action",
      p.get("action") || "",
    )}<label>Outcome<select id="outcome"><option value="">All</option><option>success</option><option>denied</option></select></label>${button(
      "Filter",
      'id="filter-audit"',
    )}</div><div class="table-scroll"><table><thead><tr><th>Actor</th><th>Target</th><th>Action</th><th>Time</th><th>Outcome</th></tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr><td>${escape(
            r.actor || "Anonymous / operator",
          )}</td><td>${escape(r.target_id || "—")}</td><td>${escape(
            r.action,
          )}</td><td>${escape(
            new Date(r.created_at).toLocaleString(),
          )}</td><td>${escape(r.outcome || "—")}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
    $("#outcome").value = p.get("outcome") || "";
    $("#filter-audit").onclick = () =>
      goto(
        `/admin/audit-log?action=${encodeURIComponent(
          $("[name=audit-action]").value,
        )}&outcome=${$("#outcome").value}`,
      );
  }
  $("#admin-content").insertAdjacentHTML(
    "beforeend",
    `<div class="pagination">${button(
      "Previous",
      `id="admin-prev" ${page === 0 ? "disabled" : ""}`,
    )}<span>Page ${page + 1}</span>${button("Next", 'id="admin-next"')}</div>`,
  );
  const pageto = (n) => {
    const p = params();
    p.set("page", n);
    return goto(`${route()}?${p}`);
  };
  $("#admin-prev").onclick = () => pageto(page - 1);
  $("#admin-next").onclick = () => pageto(page + 1);
  doc
    .querySelectorAll("[data-issue]")
    .forEach((b) => (b.onclick = () => issueLink(b.dataset.issue)));
}
async function boot() {
  state.me = await api("/me");
  state.workspaces = await api("/workspaces");
}
async function render() {
  const generation = ++state.generation,
    path = route();
  closeMenu?.();
  selectedScenes.clear();
  $("#selection-toolbar")?.remove();
  if (["/forgot-password", "/reset-password", "/set-password"].includes(path)) {
    authPage(path.slice(1));
    return;
  }
  if (!state.me) {
    authPage("login");
    return;
  }
  if (path === "/" || path === "/login") {
    return goto("/dashboard", true);
  }
  if (path === "/account/change-password") {
    authPage("change-password");
    return;
  }
  try {
    const workspaces = await api("/workspaces");
    if (generation !== state.generation) return;
    state.workspaces = workspaces;
    const selected = params().get("workspace");
    state.workspace =
      state.workspaces.find(
        (w) => w.id === (selected || state.workspace?.id),
      ) || (!selected ? state.workspaces[0] : null);
    state.collections = [];
    if (state.workspace && can("collection.read")) {
      for (let page = 0; ; page++) {
        const batch = await api(
          `/workspaces/${state.workspace.id}/collections?page=${page}`,
        );
        if (generation !== state.generation) return;
        state.collections.push(...batch);
        if (batch.length < 100) break;
      }
    }
    if (generation !== state.generation) return;
    shell();
    if (path.startsWith("/admin/")) return await adminPage(generation);
    if (!state.workspace) {
      $("#page").innerHTML =
        "<h1>No workspace assigned. Contact your administrator.</h1>";
      return;
    }
    await drawingsPage(generation);
  } catch (error) {
    if (generation !== state.generation) return;
    if ($("#page"))
      $("#page").innerHTML = `<p role="alert">${escape(
        error.message,
      )}</p><button id="retry">Retry</button>`;
    if ($("#retry")) $("#retry").onclick = render;
  }
}
doc.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-visibility]");
  if (toggle) {
    const field = toggle.closest("label").querySelector("input");
    field.type = field.type === "password" ? "text" : "password";
    toggle.textContent = field.type === "password" ? "Show" : "Hide";
    toggle.setAttribute(
      "aria-label",
      `${toggle.textContent} ${toggle.dataset.visibility.replaceAll("_", " ")}`,
    );
    return;
  }
  const a = event.target.closest("a");
  if (
    a &&
    a.origin === win.location.origin &&
    !a.pathname.startsWith("/editor") &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.button === 0
  ) {
    event.preventDefault();
    goto(a.pathname + a.search + a.hash);
  }
});
$("#dialog").addEventListener("close", () => {
  if (!$("#dialog").open) {
    $("#dialog").replaceChildren();
    $("#dialog").className = "";
  }
});
win.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    e.key.toLowerCase() === "p" &&
    state.me &&
    state.workspace
  ) {
    e.preventDefault();
    if (!$("#dialog").open) quickSearch();
  }
});
try {
  doc.documentElement.dataset.theme =
    win.localStorage.getItem("workspace-theme") || "light";
} catch {}
win.addEventListener("popstate", render);
// Return from a hidden tab only after session/permissions have been checked again.
doc.addEventListener("visibilitychange", () => {
  if (
    !doc.hidden &&
    state.me &&
    !$("#dialog").open &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(doc.activeElement?.tagName)
  )
    render();
});
if (["/forgot-password", "/reset-password", "/set-password"].includes(route()))
  render();
else
  boot()
    .catch(() => {})
    .then(render);
