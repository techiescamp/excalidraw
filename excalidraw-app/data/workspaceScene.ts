// The stylesheet loads first on purpose: moving it below the other imports
// would let their styles win the cascade. import/order cannot see that.
// eslint-disable-next-line import/order
import "./workspaceScene.css";

import {
  getNonDeletedElements,
  hashElementsVersion,
} from "@excalidraw/element";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

const API = import.meta.env.VITE_APP_API_URL || "/api";
type BlobRef = {
  id?: string;
  sha256: string;
  mimeType: string;
  created?: number;
};
type Payload = {
  type: string;
  version: number;
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  // Images are addressed by the digest of their own bytes rather than carried
  // inside the drawing, so one holding a hundred of them is a small document
  // and a hundred files the browser caches and shares with every other drawing
  // that uses the same icons.
  blobRefs?: Record<string, BlobRef>;
};

// Fetches the images a drawing refers to. A single unreadable one becomes a
// blank image rather than stopping the drawing from opening: the author can
// see and fix the rest, which refusing the whole scene never allowed.
async function resolveBlobRefs(
  workspace: string,
  payload: Payload,
): Promise<Payload> {
  const refs = payload.blobRefs;
  if (!refs || !Object.keys(refs).length) {
    return payload;
  }
  const files: BinaryFiles = { ...(payload.files || {}) };
  const missing: string[] = [];
  await Promise.all(
    Object.entries(refs).map(async ([fileId, ref]) => {
      try {
        const response = await fetch(
          `${API}/workspaces/${workspace}/blobs/${ref.sha256}`,
          { credentials: "include" },
        );
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const blob = await response.blob();
        const dataURL = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        files[fileId] = {
          id: fileId as BinaryFiles[string]["id"],
          mimeType: ref.mimeType as BinaryFiles[string]["mimeType"],
          dataURL: dataURL as BinaryFiles[string]["dataURL"],
          created: ref.created ?? Date.now(),
        };
      } catch {
        missing.push(fileId);
      }
    }),
  );
  if (missing.length) {
    // Saving now would write the drawing back without them, so the editor is
    // told, and the author decides.
    console.warn(
      `${missing.length} image(s) could not be loaded for this drawing`,
    );
  }
  const { blobRefs, ...rest } = payload;
  return { ...rest, files };
}
type Draft = { key: string; version: number; scene: Payload };
type SavedScene = {
  room_id: string | null;
  collaboration: { roomId: string; roomKey: string } | null;
  name: string;
  metadata_version: number;
  id: string;
  workspace_id: string;
  version: number;
  permissions: Record<string, boolean>;
  scene: Payload;
  has_thumbnail?: boolean;
};
type EditorSession = {
  name: string;
  metadataVersion: number;
  returnTo: string;
  id: string;
  userId: string;
  workspace: string;
  key: string;
  version: number;
  editable: boolean;
  loaded: boolean;
  current: string;
  // The scene as the canvas last had it, by reference. Turned into a payload
  // once a save is actually due; see `materialize`.
  latest?: {
    elements: readonly OrderedExcalidrawElement[];
    appState: AppState;
    files: BinaryFiles;
  };
  // Cheap answer to "has anything that is stored actually changed?"; see
  // `saveWorkspaceScene`.
  signature?: string;
  pending?: Payload;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  error?: string;
  generation: number;
  acknowledged: number;
  renaming?: boolean;
  // What the status bar was last built for; see `showStatus`.
  statusShape?: string;
  thumbnail?: Promise<void>;
  // A preview waiting for the drawing to sit still; see `scheduleThumbnail`.
  thumbnailDue?: { version: number; scene: Payload };
  thumbnailTimer?: ReturnType<typeof setTimeout>;
};
let node: HTMLElement;
let status: HTMLElement;
let userId = "";
let userLabel = "Account";
let permissions: Record<string, boolean> | null = null;
const listeners = new Set<() => void>();
const activeWorkspaceListeners = new Set<() => void>();
export const subscribeActiveWorkspace = (listener: () => void) => {
  activeWorkspaceListeners.add(listener);
  return () => activeWorkspaceListeners.delete(listener);
};
export const getActiveWorkspaceId = () => active?.workspace ?? null;
export const subscribeWorkspacePermissions = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getWorkspacePermissions = () => permissions;
let active: EditorSession | undefined;
const sessions = new Map<string, EditorSession>();
let database: Promise<IDBDatabase>;
const openDatabase = () =>
  (database ||= new Promise((resolve, reject) => {
    const request = node.ownerDocument.defaultView!.indexedDB.open(
      "excalidraw-workspace-drafts",
      1,
    );
    request.onupgradeneeded = () =>
      request.result.createObjectStore("drafts", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
async function draftStore(
  operation: "get" | "put" | "delete",
  key: string,
  value?: Draft,
): Promise<Draft | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      "drafts",
      operation === "get" ? "readonly" : "readwrite",
    );
    const store = tx.objectStore("drafts");
    const request =
      operation === "get"
        ? store.get(key)
        : operation === "put"
        ? store.put(value)
        : store.delete(key);
    tx.oncomplete = () =>
      resolve(operation === "get" ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await node.ownerDocument.defaultView!.fetch(
    `${API}${path}`,
    {
      ...options,
      credentials: "include",
      headers: {
        "X-Excalidraw-Request": "1",
        "Content-Type": "application/json",
        ...options.headers,
      },
    },
  );
  if (!response.ok) {
    if (response.status === 401) {
      if (active) {
        active.loaded = false;
      }
      node.replaceChildren();
      node.ownerDocument.defaultView!.location.replace("/login");
    }
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || "Save failed"), {
      status: response.status,
    });
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const scenePayload = (
  elements: readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): Payload => ({
  type: "excalidraw",
  version: 2,
  elements,
  appState: {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
  },
  files,
});
function showStatus(session: EditorSession, text: string) {
  if (active !== session) {
    return;
  }
  const shown = status.querySelector('[role="status"]');
  if (session.renaming) {
    // an inline rename is in progress: refresh only the status text so the
    // input being typed into is not torn down by an autosave tick
    if (shown) {
      shown.textContent = text;
      return;
    }
  }
  // Everything below builds the whole bar: the back link, the title button and
  // its handler, the Scenes button, and the error buttons. That ran on every
  // change the editor reported, which while drawing is every frame, and all of
  // it to change one word. Nothing but the word differs between those calls,
  // so when that is true the word is all that is replaced. If the bar has been
  // taken apart by something else the query below finds nothing and it is
  // rebuilt as before.
  const shape = `${session.name}\u0000${session.error || ""}\u0000${
    permissions?.["drawing.rename"] ? "1" : "0"
  }`;
  if (shown && session.statusShape === shape) {
    if (shown.textContent !== text) {
      shown.textContent = text;
    }
    return;
  }
  session.statusShape = shape;
  status.replaceChildren();
  status.classList.toggle("has-error", Boolean(session.error));
  const doc = node.ownerDocument;
  const message = doc.createElement("span");
  message.textContent = text;
  message.setAttribute("role", "status");
  status.append(message);
  const link = doc.createElement("a");
  link.href = session.returnTo;
  link.textContent = "‹";
  link.className = "workspace-back";
  link.title = "Back to collection";
  link.setAttribute("aria-label", "Back to collection");
  status.prepend(link);
  const title = doc.createElement("button");
  title.textContent = session.name;
  title.title = "Rename scene";
  title.className = "workspace-scene-title";
  title.disabled = !permissions?.["drawing.rename"];
  title.style.cssText =
    "border:0;background:transparent;color:inherit;font:inherit;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer";
  title.onclick = () => startInlineRename(session, title);
  const scenes = doc.createElement("button");
  scenes.textContent = "Scenes";
  scenes.className = "workspace-scenes-button";
  scenes.onclick = () => void showCollectionScenes(session);
  status.append(scenes);
  status.prepend(title);
  if (session.error) {
    const copy = doc.createElement("button");
    copy.textContent = "Save draft as a copy";
    copy.onclick = async () => {
      if (!session.pending) {
        return;
      }
      copy.disabled = true;
      try {
        const saved = await request<{ id: string }>("/scenes", {
          method: "POST",
          headers: { "Idempotency-Key": doc.defaultView!.crypto.randomUUID() },
          body: JSON.stringify({
            workspace_id: session.workspace,
            name: "Recovered drawing",
            private: true,
            scene: session.pending,
          }),
        });
        await draftStore("delete", session.key);
        session.pending = undefined;
        doc.defaultView!.location.assign(`/editor?scene=${saved.id}`);
      } catch (error: any) {
        showStatus(session, error.message);
      }
    };
    const retry = doc.createElement("button");
    retry.textContent = "Retry save";
    retry.onclick = () => {
      session.error = undefined;
      void flush(session);
    };
    const reload = doc.createElement("button");
    reload.textContent = "Reload server version";
    reload.onclick = async () => {
      if (
        doc.defaultView!.confirm(
          "Discard this recovery draft and reload the server version?",
        )
      ) {
        await draftStore("delete", session.key);
        session.pending = undefined;
        doc.defaultView!.location.reload();
      }
    };
    status.append(copy, retry, reload);
  }
}
function startInlineRename(session: EditorSession, title: HTMLButtonElement) {
  const doc = node.ownerDocument;
  const input = doc.createElement("input");
  input.className = "workspace-scene-title-input";
  input.value = session.name;
  input.maxLength = 80;
  input.setAttribute("aria-label", "Scene name");
  session.renaming = true;
  title.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (commit: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    const name = input.value.trim();
    if (commit && name && name !== session.name) {
      input.disabled = true;
      try {
        const saved = await request<{ name: string; metadata_version: number }>(
          `/scenes/${session.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ name, version: session.metadataVersion }),
          },
        );
        session.name = saved.name;
        session.metadataVersion = saved.metadata_version;
        doc.title = `${saved.name} — Excalidraw`;
        const row = doc.querySelector(
          ".workspace-scenes-panel nav a[aria-current] strong",
        );
        if (row) {
          row.textContent = saved.name;
        }
      } catch (error: any) {
        session.renaming = false;
        showStatus(session, `Rename failed: ${error.message}`);
        return;
      }
    }
    session.renaming = false;
    showStatus(
      session,
      session.error || (session.pending ? "Saving…" : "Saved"),
    );
  };
  input.onkeydown = (event) => {
    // keep the canvas shortcuts from reacting to keystrokes typed here
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      void finish(false);
    }
  };
  input.onblur = () => void finish(true);
}
type SceneRow = {
  id: string;
  name: string;
  thumb_s3_key?: string | null;
  scene_version: number;
  metadata_version: number;
  owner_name: string;
  pinned: boolean;
  private_owner_id: string | null;
  created_at: string;
  updated_at: string;
  collections: Array<{ id: string; name: string }>;
};
type SceneList = { items: SceneRow[]; total: number };
type MenuItem = {
  label: string;
  icon?: string;
  danger?: boolean;
  checked?: boolean;
  action?: () => unknown;
  children?: MenuItem[];
};

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  more: svg(
    '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  ),
  sort: svg(
    '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  ),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  edit: svg(
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  ),
  share: svg(
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  ),
  link: svg(
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  ),
  export: svg(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  ),
  file: svg(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  ),
  pin: svg(
    '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"/>',
  ),
  copy: svg(
    '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  ),
  move: svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  trash: svg(
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  ),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
};

const SORT_KEY = "excalidraw-workspace-scene-sort";
const SORTS = [
  ["title", "Name"],
  ["created", "Last created"],
  ["updated", "Last updated"],
] as const;
type SortOrder = typeof SORTS[number][0];
const sortOrder = (): SortOrder => {
  try {
    const saved =
      node.ownerDocument.defaultView!.localStorage.getItem(SORT_KEY);
    return SORTS.find(([key]) => key === saved)?.[0] || "title";
  } catch {
    return "title";
  }
};
const setSortOrder = (order: SortOrder) => {
  try {
    node.ownerDocument.defaultView!.localStorage.setItem(SORT_KEY, order);
  } catch {}
};

const timeAgo = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  for (const [unit, size] of [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const) {
    const count = Math.floor(seconds / size);
    if (count >= 1) {
      return count === 1
        ? `${unit === "hour" ? "an" : "a"} ${unit} ago`
        : `${count} ${unit}s ago`;
    }
  }
  return "just now";
};

// the metadata version the server expects for this scene's next rename/pin/move
const sceneVersion = (session: EditorSession, scene: SceneRow) =>
  scene.id === session.id
    ? Math.max(session.metadataVersion, scene.metadata_version)
    : scene.metadata_version;

function showToast(text: string, error = false) {
  const doc = node.ownerDocument;
  doc.querySelector(".workspace-toast")?.remove();
  const toast = doc.createElement("div");
  toast.className = "workspace-toast";
  toast.classList.toggle("error", error);
  toast.setAttribute("role", error ? "alert" : "status");
  toast.textContent = text;
  doc.body.append(toast);
  doc.defaultView!.setTimeout(() => toast.remove(), 4000);
}

let closeMenu: (() => void) | undefined;
function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  closeMenu?.();
  const doc = node.ownerDocument;
  const win = doc.defaultView!;
  // menus[0] is the root menu, menus[n] the submenu opened from menus[n - 1]
  const menus: HTMLElement[] = [];
  const closeFrom = (level: number) => {
    for (const menu of menus.splice(level)) {
      menu.remove();
    }
    menus[level - 1]
      ?.querySelectorAll('[aria-expanded="true"]')
      .forEach((item) => item.setAttribute("aria-expanded", "false"));
  };
  const place = (menu: HTMLElement, x: number, y: number) => {
    doc.body.append(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(
      8,
      Math.min(x, win.innerWidth - width - 8),
    )}px`;
    menu.style.top = `${Math.max(
      8,
      Math.min(y, win.innerHeight - height - 8),
    )}px`;
  };
  const build = (entries: MenuItem[], depth: number) => {
    const menu = doc.createElement("div");
    menu.className = "workspace-menu";
    menu.setAttribute("role", "menu");
    entries.forEach((entry, index) => {
      if (entry.danger && index > 0) {
        const separator = doc.createElement("div");
        separator.className = "workspace-menu-separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "workspace-menu-item";
      item.classList.toggle("danger", Boolean(entry.danger));
      if (entry.checked === undefined) {
        item.setAttribute("role", "menuitem");
      } else {
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(entry.checked));
      }
      const icon = doc.createElement("span");
      icon.className = "workspace-menu-icon";
      icon.innerHTML = entry.checked ? ICONS.check : entry.icon || "";
      const text = doc.createElement("span");
      text.textContent = entry.label;
      item.append(icon, text);
      const openSubmenu = () => {
        if (item.getAttribute("aria-expanded") !== "true") {
          closeFrom(depth + 1);
          item.setAttribute("aria-expanded", "true");
          const rect = item.getBoundingClientRect();
          menus[depth + 1] = build(entry.children!, depth + 1);
          place(menus[depth + 1], rect.right + 4, rect.top - 6);
        }
        return menus[depth + 1];
      };
      if (entry.children) {
        item.setAttribute("aria-haspopup", "menu");
        item.setAttribute("aria-expanded", "false");
        const chevron = doc.createElement("span");
        chevron.className = "workspace-menu-chevron";
        chevron.innerHTML = ICONS.chevron;
        item.append(chevron);
      }
      item.onmouseenter = () =>
        entry.children ? void openSubmenu() : closeFrom(depth + 1);
      item.onclick = () => {
        if (entry.children) {
          openSubmenu().querySelector<HTMLElement>("button")?.focus();
          return;
        }
        close();
        void entry.action?.();
      };
      menu.append(item);
    });
    return menu;
  };
  const onPointerDown = (event: Event) => {
    const target = event.target as Node;
    if (
      !menus.some((menu) => menu.contains(target)) &&
      !anchor.contains(target)
    ) {
      close();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // keep canvas shortcuts from reacting while the menu owns the keyboard
    event.stopPropagation();
    const menu =
      menus.find((m) => m.contains(doc.activeElement)) ||
      menus[menus.length - 1];
    const level = menus.indexOf(menu);
    const buttons = [
      ...menu.querySelectorAll<HTMLButtonElement>(".workspace-menu-item"),
    ];
    const index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    } else if (
      event.key === "ArrowRight" &&
      buttons[index]?.hasAttribute("aria-haspopup")
    ) {
      event.preventDefault();
      buttons[index].click();
    } else if (
      event.key === "Escape" ||
      (event.key === "ArrowLeft" && level > 0)
    ) {
      event.preventDefault();
      if (level > 0) {
        const opener = menus[level - 1].querySelector<HTMLElement>(
          '[aria-expanded="true"]',
        );
        closeFrom(level);
        opener?.focus();
      } else {
        close();
        anchor.focus();
      }
    } else if (event.key === "Tab") {
      close();
    }
  };
  const close = () => {
    closeFrom(0);
    anchor.setAttribute("aria-expanded", "false");
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    win.removeEventListener("resize", close);
    closeMenu = undefined;
  };
  menus[0] = build(items, 0);
  const rect = anchor.getBoundingClientRect();
  place(menus[0], rect.left, rect.bottom + 4);
  anchor.setAttribute("aria-expanded", "true");
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("resize", close);
  closeMenu = close;
  menus[0].querySelector<HTMLElement>("button")?.focus();
}

function dialogField(label: string, control: HTMLElement) {
  const wrapper = node.ownerDocument.createElement("label");
  wrapper.className = "workspace-dialog-field";
  wrapper.append(label, control);
  return wrapper;
}

function editorDialog(
  title: string,
  body: HTMLElement[],
  submitLabel: string,
  onSubmit: () => Promise<void>,
  danger = false,
) {
  const doc = node.ownerDocument;
  const dialog = doc.createElement("dialog");
  dialog.className = "workspace-dialog";
  const form = doc.createElement("form");
  const heading = doc.createElement("h2");
  heading.textContent = title;
  const error = doc.createElement("p");
  error.className = "workspace-dialog-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = doc.createElement("div");
  actions.className = "workspace-dialog-actions";
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.onclick = () => dialog.close();
  const submit = doc.createElement("button");
  submit.type = "submit";
  submit.className = danger ? "danger" : "primary";
  submit.textContent = submitLabel;
  actions.append(cancel, submit);
  form.append(heading, ...body, error, actions);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
      await onSubmit();
      dialog.close();
    } catch (e: any) {
      error.textContent = e.message;
      error.hidden = false;
      submit.disabled = false;
    }
  };
  dialog.addEventListener("keydown", (event) => {
    // typing in the dialog must not trigger canvas shortcuts
    event.stopPropagation();
    // submit from text fields explicitly instead of relying on implicit
    // submission, which some key event sources do not trigger
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      (event.target as Element).matches("input:not([type=button])")
    ) {
      event.preventDefault();
      if (!submit.disabled) {
        form.requestSubmit(submit);
      }
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(form);
  doc.body.append(dialog);
  dialog.showModal();
  form
    .querySelector<HTMLElement>("input, select, button[type=submit]")
    ?.focus();
  return dialog;
}

function renameScene(
  session: EditorSession,
  scene: SceneRow,
  row: HTMLElement,
) {
  if (scene.id === session.id) {
    const title = status.querySelector<HTMLButtonElement>(
      ".workspace-scene-title",
    );
    if (title && !title.disabled) {
      startInlineRename(session, title);
      return;
    }
  }
  const input = node.ownerDocument.createElement("input");
  input.required = true;
  input.maxLength = 80;
  input.value = scene.name;
  editorDialog(
    "Rename scene",
    [dialogField("Scene name", input)],
    "Rename scene",
    async () => {
      const saved = await request<{ name: string; metadata_version: number }>(
        `/scenes/${scene.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: input.value.trim(),
            version: sceneVersion(session, scene),
          }),
        },
      );
      scene.name = saved.name;
      scene.metadata_version = saved.metadata_version;
      row.dataset.sceneName = saved.name.toLowerCase();
      const label = row.querySelector("strong");
      if (label) {
        label.textContent = saved.name;
      }
    },
  );
  input.select();
}

function shareScene(scene: SceneRow) {
  const doc = node.ownerDocument;
  const win = doc.defaultView!;
  const link = `${win.location.origin}/editor?scene=${scene.id}`;
  const input = doc.createElement("input");
  input.readOnly = true;
  input.value = link;
  const note = doc.createElement("p");
  note.textContent =
    "Only signed-in members who can access this scene can open the link.";
  editorDialog(
    `Share “${scene.name}”`,
    [dialogField("Scene link", input), note],
    "Copy link",
    async () => {
      try {
        await win.navigator.clipboard.writeText(link);
      } catch {
        input.select();
        if (!doc.execCommand("copy")) {
          throw new Error("Copy failed. Select the link and copy it manually.");
        }
      }
      showToast("Link copied.");
    },
  );
  input.select();
}

async function quickExport(
  session: EditorSession,
  scene: SceneRow,
  format: "svg" | "png" | "json",
) {
  const doc = node.ownerDocument;
  const win = doc.defaultView!;
  try {
    if (scene.id === session.id) {
      await flush(session);
    }
    const payload = await request<Payload>(`/scenes/${scene.id}/export`);
    const input = {
      elements: getNonDeletedElements(payload.elements),
      appState: { ...payload.appState, exportBackground: true },
      files: payload.files || {},
    };
    const blob =
      format === "json"
        ? new win.Blob([JSON.stringify(payload)], {
            type: "application/vnd.excalidraw+json",
          })
        : format === "svg"
        ? new win.Blob([(await exportToSvg(input)).outerHTML], {
            type: "image/svg+xml",
          })
        : await exportToBlob({ ...input, mimeType: "image/png" });
    const url = win.URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = `${scene.name.replace(/[\\/:*?"<>|]+/g, "-")}.${
      format === "json" ? "excalidraw" : format
    }`;
    doc.body.append(link);
    link.click();
    link.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  } catch (error: any) {
    showToast(`Export failed: ${error.message}`, true);
  }
}

async function destinationDialog(
  session: EditorSession,
  scene: SceneRow,
  duplicate: boolean,
  reload: () => Promise<unknown>,
) {
  const doc = node.ownerDocument;
  let collections: Array<{ id: string; name: string }>;
  try {
    collections = await request(`/workspaces/${session.workspace}/collections`);
  } catch (error: any) {
    showToast(error.message, true);
    return;
  }
  const current = scene.private_owner_id
    ? "private"
    : scene.collections[0]?.id || "private";
  const select = doc.createElement("select");
  for (const collection of [
    { id: "private", name: "Private" },
    ...collections,
  ]) {
    const option = doc.createElement("option");
    option.value = collection.id;
    option.textContent =
      collection.id === current && !duplicate
        ? `${collection.name} (current)`
        : collection.name;
    option.selected = collection.id === current;
    select.append(option);
  }
  const name = doc.createElement("input");
  name.required = true;
  name.maxLength = 80;
  name.value = `${scene.name} copy`;
  const label = duplicate ? "Duplicate scene" : "Move scene";
  editorDialog(
    label,
    [
      ...(duplicate ? [dialogField("Scene name", name)] : []),
      dialogField("Target collection", select),
    ],
    label,
    async () => {
      const target = select.value;
      const isPrivate = target === "private";
      if (duplicate) {
        await request(`/scenes/${scene.id}/duplicate`, {
          method: "POST",
          headers: { "Idempotency-Key": doc.defaultView!.crypto.randomUUID() },
          body: JSON.stringify({
            name: name.value.trim(),
            collection_id: isPrivate ? null : target,
            private: isPrivate,
          }),
        });
      } else {
        if (target === current) {
          throw new Error("The scene is already in this collection.");
        }
        await request(`/scenes/${scene.id}/move`, {
          method: "POST",
          body: JSON.stringify({
            collection_id: isPrivate ? null : target,
            private: isPrivate,
            version: sceneVersion(session, scene),
          }),
        });
      }
      showToast(duplicate ? "Scene duplicated." : "Scene moved.");
      await reload();
    },
  );
}

function trashScene(
  session: EditorSession,
  scene: SceneRow,
  reload: () => Promise<unknown>,
) {
  const doc = node.ownerDocument;
  const text = doc.createElement("p");
  const name = doc.createElement("strong");
  name.textContent = scene.name;
  text.append("You can restore ", name, " from Trash.");
  editorDialog(
    "Move scene to trash?",
    [text],
    "Move to trash",
    async () => {
      const isCurrent = scene.id === session.id;
      if (isCurrent) {
        await flush(session);
      }
      await request(`/scenes/${scene.id}`, { method: "DELETE" });
      if (isCurrent) {
        session.pending = undefined;
        await draftStore("delete", session.key).catch(() => {});
        doc.defaultView!.location.assign(session.returnTo);
        return;
      }
      showToast("Scene moved to Trash.");
      await reload();
    },
    true,
  );
}

function sceneActions(
  session: EditorSession,
  scene: SceneRow,
  row: HTMLElement,
  reload: () => Promise<unknown>,
): MenuItem[] {
  const can = (permission: string) => Boolean(permissions?.[permission]);
  const items: MenuItem[] = [];
  if (can("drawing.rename")) {
    items.push({
      label: "Rename",
      icon: ICONS.edit,
      action: () => renameScene(session, scene, row),
    });
  }
  items.push({
    label: "Share",
    icon: ICONS.share,
    children: [
      {
        label: "Share scene",
        icon: ICONS.link,
        action: () => shareScene(scene),
      },
    ],
  });
  if (can("drawing.export")) {
    items.push({
      label: "Quick export",
      icon: ICONS.export,
      children: (
        [
          ["svg", "Scene as SVG"],
          ["png", "Scene as PNG"],
          ["json", "Scene as JSON"],
        ] as const
      ).map(([format, label]) => ({
        label,
        icon: ICONS.file,
        action: () => quickExport(session, scene, format),
      })),
    });
  }
  if (can("drawing.rename")) {
    items.push({
      label: scene.pinned ? "Unpin" : "Pin",
      icon: ICONS.pin,
      action: async () => {
        try {
          const saved = await request<{ metadata_version: number }>(
            `/scenes/${scene.id}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                pinned: !scene.pinned,
                version: sceneVersion(session, scene),
              }),
            },
          );
          if (scene.id === session.id) {
            session.metadataVersion = saved.metadata_version;
          }
          await reload();
        } catch (error: any) {
          showToast(error.message, true);
        }
      },
    });
  }
  if (can("drawing.duplicate")) {
    items.push({
      label: "Duplicate",
      icon: ICONS.copy,
      action: () => destinationDialog(session, scene, true, reload),
    });
  }
  if (can("drawing.edit") && can("collection.remove")) {
    items.push({
      label: "Move",
      icon: ICONS.move,
      action: () => destinationDialog(session, scene, false, reload),
    });
  }
  if (can("drawing.trash")) {
    items.push({
      label: "Move to trash",
      icon: ICONS.trash,
      danger: true,
      action: () => trashScene(session, scene, reload),
    });
  }
  return items;
}

function sceneRow(
  session: EditorSession,
  scene: SceneRow,
  reload: () => Promise<unknown>,
) {
  const doc = node.ownerDocument;
  const row = doc.createElement("div");
  row.className = "workspace-scene-row";
  row.dataset.sceneName = scene.name.toLowerCase();
  const link = doc.createElement("a");
  link.href = `/editor?scene=${scene.id}&returnTo=${encodeURIComponent(
    session.returnTo,
  )}`;
  const caption = doc.createElement("span");
  const label = doc.createElement("strong");
  const author = doc.createElement("small");
  const when = doc.createElement("small");
  label.textContent = scene.name;
  author.textContent = `by ${scene.owner_name}`;
  when.textContent = timeAgo(
    sortOrder() === "created" ? scene.created_at : scene.updated_at,
  );
  if (scene.pinned) {
    const pin = doc.createElement("span");
    pin.className = "workspace-scene-pin";
    pin.title = "Pinned";
    pin.innerHTML = ICONS.pin;
    when.prepend(pin);
  }
  caption.append(label, author, when);
  if (scene.thumb_s3_key) {
    const image = doc.createElement("img");
    image.src = `${API}/scenes/${scene.id}/thumbnail?v=${scene.scene_version}`;
    image.alt = "";
    link.append(image);
  }
  link.append(caption);
  if (scene.id === session.id) {
    link.setAttribute("aria-current", "page");
  }
  const more = doc.createElement("button");
  more.type = "button";
  more.className = "workspace-scene-more";
  more.innerHTML = ICONS.more;
  more.title = "Scene actions";
  more.setAttribute("aria-label", `Actions for ${scene.name}`);
  more.setAttribute("aria-haspopup", "menu");
  more.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(more, sceneActions(session, scene, row, reload));
  };
  row.append(link, more);
  return row;
}

/**
 * Tells the editor its canvas changed size.
 *
 * This sidebar narrows the editor by shrinking `#root`, which the window
 * never hears about — and the editor only re-measures on a window resize.
 * So it went on believing it was as wide as the window: every piece of
 * viewport arithmetic it did, centring a drawing included, divided by a width
 * 272px larger than the canvas it was drawing into. Work landed off to one
 * side or off the screen entirely, and toggling the sidebar moved it again,
 * which is what "it was here, now it is there" was.
 *
 * Sent straight away rather than on the next frame. The editor's own
 * ResizeObserver would notice eventually, but observers and animation frames
 * both stop running while a tab is in the background, so a drawing opened in
 * a tab that is not on top came back measured wrong. Reading the new size
 * forces the browser to lay it out first, so this is never a frame early.
 */
function notifyEditorResized() {
  const win = node?.ownerDocument.defaultView;
  if (!win) {
    return;
  }
  node.ownerDocument.documentElement.getBoundingClientRect();
  win.dispatchEvent(new win.Event("resize"));
}

async function showCollectionScenes(session: EditorSession) {
  const doc = node.ownerDocument;
  const old = doc.querySelector(".workspace-scenes-panel");
  if (old) {
    old.remove();
    doc.documentElement.classList.remove("workspace-sidebar-open");
    notifyEditorResized();
    return;
  }
  const panel = doc.createElement("aside");
  panel.className = "workspace-scenes-panel";
  panel.setAttribute("aria-label", "Collection scenes");
  const heading = doc.createElement("h2");
  const close = doc.createElement("button");
  const list = doc.createElement("nav");
  heading.textContent = "Collection scenes";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close scene list");
  close.className = "workspace-panel-close";
  close.onclick = () => {
    panel.remove();
    doc.documentElement.classList.remove("workspace-sidebar-open");
    notifyEditorResized();
  };
  panel.append(close, heading, list);
  doc.body.append(panel);
  doc.documentElement.classList.add("workspace-sidebar-open");
  notifyEditorResized();
  const context = new URL(session.returnTo, doc.defaultView!.location.origin)
    .searchParams;
  const query = new URLSearchParams({
    workspace: session.workspace,
    limit: "100",
    sort: sortOrder(),
  });
  if (context.get("collection")) {
    query.set("collection", context.get("collection")!);
  } else if (context.get("view") === "private") {
    query.set("private", "1");
    heading.textContent = "Private scenes";
  }
  const back = doc.createElement("a");
  back.href = session.returnTo;
  back.textContent = "‹";
  back.className = "workspace-panel-back";
  back.title = "Back to collection";
  back.setAttribute("aria-label", "Back to collection");
  const header = doc.createElement("div");
  header.className = "workspace-panel-header";
  panel.insertBefore(header, heading);
  header.append(back, heading);
  const search = doc.createElement("input");
  search.type = "search";
  search.placeholder = "Search scenes…";
  search.setAttribute("aria-label", "Search collection scenes");
  panel.insertBefore(search, header);
  const account = doc.createElement("a");
  account.className = "workspace-panel-account";
  account.href = "/account/change-password";
  account.textContent = userLabel;
  panel.append(account);
  const sortButton = doc.createElement("button");
  sortButton.type = "button";
  sortButton.className = "workspace-panel-icon";
  sortButton.innerHTML = ICONS.sort;
  sortButton.title = "Sort scenes";
  sortButton.setAttribute("aria-label", "Sort scenes");
  sortButton.setAttribute("aria-haspopup", "menu");
  header.append(sortButton);
  const applySearch = () =>
    list.querySelectorAll<HTMLElement>("[data-scene-name]").forEach((row) => {
      row.hidden = !row.dataset.sceneName!.includes(search.value.toLowerCase());
    });
  search.oninput = applySearch;
  const reload = async (): Promise<SceneList | undefined> => {
    query.set("sort", sortOrder());
    const result = await request<SceneList>(`/scenes?${query}`);
    if (!panel.isConnected) {
      return undefined;
    }
    list.replaceChildren(
      ...result.items.map((scene) => sceneRow(session, scene, reload)),
    );
    const current = result.items.find((scene) => scene.id === session.id);
    if (current) {
      session.metadataVersion = Math.max(
        session.metadataVersion,
        current.metadata_version,
      );
    }
    if (result.total > 100) {
      const more = doc.createElement("a");
      more.href = session.returnTo;
      more.textContent = `View all ${result.total} scenes`;
      list.append(more);
    }
    applySearch();
    return result;
  };
  sortButton.onclick = () =>
    openMenu(
      sortButton,
      SORTS.map(([key, label]) => ({
        label,
        checked: sortOrder() === key,
        action: () => {
          setSortOrder(key);
          void reload().catch((error: any) => showToast(error.message, true));
        },
      })),
    );
  list.textContent = "Loading…";
  try {
    const [result, workspaces] = await Promise.all([
      reload(),
      request<Array<{ id: string; name: string }>>("/workspaces"),
    ]);
    if (!result) {
      return;
    }
    const workspace = doc.createElement("strong");
    workspace.className = "workspace-panel-name";
    workspace.textContent =
      workspaces.find((w) => w.id === session.workspace)?.name || "Workspace";
    panel.prepend(workspace);
    const dashboard = doc.createElement("a");
    dashboard.href = `/dashboard?workspace=${session.workspace}`;
    dashboard.textContent = "▦  Dashboard";
    panel.insertBefore(dashboard, header);
    const current = result.items.find((s) => s.id === session.id);
    heading.textContent =
      current?.collections.find((c) => c.id === context.get("collection"))
        ?.name || heading.textContent;
    if (!panel.isConnected) {
      return;
    }
    if (permissions?.["drawing.create"]) {
      const create = doc.createElement("button");
      create.type = "button";
      create.className = "workspace-panel-add";
      create.innerHTML = ICONS.plus;
      create.title = "Create scene";
      create.setAttribute("aria-label", "Create scene");
      create.onclick = async () => {
        create.disabled = true;
        await flush(session);
        if (session.pending) {
          create.disabled = false;
          return;
        }
        try {
          const scene = await request<{ id: string }>("/scenes", {
            method: "POST",
            headers: {
              "Idempotency-Key": doc.defaultView!.crypto.randomUUID(),
            },
            body: JSON.stringify({
              workspace_id: session.workspace,
              name: "Untitled scene",
              collection_id: context.get("collection"),
              private: !context.get("collection"),
            }),
          });
          doc.defaultView!.location.assign(
            `/editor?scene=${scene.id}&returnTo=${encodeURIComponent(
              session.returnTo,
            )}`,
          );
        } catch (e: any) {
          showToast(e.message, true);
          create.disabled = false;
        }
      };
      header.append(create);
    }
  } catch (e: any) {
    list.textContent = e.message;
  }
}
export function initializeWorkspaceEditor(
  mounted: HTMLElement,
  authenticatedUserId: string,
  authenticatedUserLabel = "Account",
) {
  node = mounted;
  userId = authenticatedUserId;
  userLabel = authenticatedUserLabel;
  const doc = node.ownerDocument;
  const win = doc.defaultView!;
  status = doc.createElement("div");
  status.className = "workspace-save-status";
  doc.documentElement.classList.add("workspace-editor");
  doc.body.append(status);
  const channel = new win.BroadcastChannel("excalidraw-auth");
  channel.onmessage = () => {
    node.replaceChildren();
    win.location.replace("/login");
  };
  const revalidate = () => {
    void request("/me").catch(() => {});
  };
  win.setInterval(revalidate, 30000);
  doc.addEventListener("visibilitychange", () => {
    if (!doc.hidden) {
      revalidate();
    } else if (active) {
      // Nobody is watching this canvas, so the preview costs nothing now.
      renderDueThumbnail(active);
    }
  });
  win.addEventListener("online", () => {
    if (
      (active?.pending || active?.latest) &&
      !active.error?.includes("changed")
    ) {
      active.error = undefined;
      void flush(active);
    }
  });
  win.addEventListener("beforeunload", (event) => {
    // `latest` counts as unsaved: a change made in the last moment is on the
    // canvas and has not been turned into a payload yet.
    if (active?.pending || active?.latest || active?.running) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  doc.addEventListener(
    "click",
    async (event) => {
      const anchor = (event.target as Element).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        // export downloads are blob links on this origin, not navigation
        anchor.hasAttribute("download") ||
        !(
          active?.pending ||
          active?.latest ||
          active?.thumbnail ||
          active?.thumbnailDue
        ) ||
        anchor.origin !== win.location.origin ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      await flush(active);
      // The preview is normally left until the drawing sits still. Leaving the
      // drawing is the other moment it is wanted, and the dashboard this is
      // heading for is the only place it is seen.
      renderDueThumbnail(active);
      if (!active.pending && active.thumbnail) {
        // let the preview of the last save finish, or the dashboard keeps
        // showing the old picture and the edit looks lost
        await Promise.race([
          active.thumbnail,
          new Promise((resolve) => win.setTimeout(resolve, 4000)),
        ]);
      }
      if (
        !active.pending ||
        win.confirm(
          "Your unsaved draft is kept on this device. Leave this drawing?",
        )
      ) {
        win.location.assign(anchor.href);
      }
    },
    true,
  );
}
export const getWorkspaceSceneId = (): string | null => {
  if (!node) {
    return null;
  }
  const id = new URLSearchParams(
    node.ownerDocument.defaultView!.location.search,
  ).get("scene");
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};
export async function loadWorkspaceScene(
  id: string,
): Promise<ExcalidrawInitialDataState> {
  const result = await request<SavedScene>(`/scenes/${id}/data`);
  const ownerWindow = node.ownerDocument.defaultView!;
  const requestedRoom = ownerWindow.location.hash.match(
    /^#room=([a-zA-Z0-9_-]+),/,
  )?.[1];
  // One rewrite, never two. Stripping a wrong room and then putting the right
  // one back left a window with no room in the URL at all, and a save landing
  // in that window told the server it was not collaborative.
  const here = `${ownerWindow.location.pathname}${ownerWindow.location.search}`;
  const target = result.collaboration
    ? `${here}#room=${result.collaboration.roomId},${result.collaboration.roomKey}`
    : requestedRoom && requestedRoom !== result.room_id
    ? here
    : null;
  if (target !== null) {
    ownerWindow.history.replaceState({}, "", target);
  }
  permissions = result.permissions;
  listeners.forEach((listener) => listener());
  const win = node.ownerDocument.defaultView!;
  const requestedReturn = new URLSearchParams(win.location.search).get(
    "returnTo",
  );
  const returnTo = /^\/dashboard\/?\?/.test(requestedReturn || "")
    ? requestedReturn!
    : `/dashboard?workspace=${result.workspace_id}`;
  node.ownerDocument.title = `${result.name} — Excalidraw`;
  const session: EditorSession = {
    name: result.name,
    metadataVersion: result.metadata_version,
    returnTo,
    id,
    userId,
    workspace: result.workspace_id,
    key: `${userId}:${result.workspace_id}:${id}`,
    version: result.version,
    editable: result.permissions["drawing.edit"],
    loaded: false,
    current: "",
    generation: 0,
    acknowledged: 0,
  };
  active = session;
  activeWorkspaceListeners.forEach((listener) => listener());
  sessions.set(id, session);
  // The server hands the editor references rather than the image bytes; fetch
  // them before anything reads the scene, so the rest of this file sees the
  // same shape it always has.
  let payload = await resolveBlobRefs(result.workspace_id, result.scene);
  const draft = await draftStore("get", session.key);
  if (draft && session.editable) {
    if (draft.version !== result.version) {
      // The drawing moved on while this draft sat here, from another tab or
      // another person. The server merges by each element's own version, so the
      // draft is sent to be merged rather than the author being asked to
      // reconcile two versions by hand.
      try {
        const merged = await request<{ version: number; scene?: Payload }>(
          `/scenes/${id}/data`,
          {
            method: "PUT",
            body: JSON.stringify({
              // The draft's own version, not the server's: the server merges a
              // save it can see is behind, and overwrites one it thinks is
              // current, which would discard whatever moved the drawing on.
              version: draft.version,
              scene: draft.scene,
            }),
          },
        );
        if (merged.scene) {
          payload = await resolveBlobRefs(result.workspace_id, merged.scene);
          // The session took its version before this ran, and the merge has
          // moved the drawing on; without this the next save would look stale.
          result.version = merged.version;
          session.version = merged.version;
          await draftStore("delete", session.key);
        }
      } catch {
        // Merging is the improvement, not the guarantee. If it cannot be done
        // the draft is kept and the author decides, as before.
        session.pending = draft.scene;
        session.error =
          "Drawing changed on the server. Save your draft as a copy or reload.";
      }
    } else if (
      node.ownerDocument.defaultView!.confirm(
        "A recoverable unsaved draft exists for this drawing. Restore it?",
      )
    ) {
      payload = draft.scene;
      session.pending = draft.scene;
    } else {
      session.pending = draft.scene;
      session.error =
        "Recovery draft retained. Save it as a copy or reload to discard it.";
    }
  }
  session.current = JSON.stringify(
    scenePayload(payload.elements, payload.appState, payload.files),
  );
  session.loaded = true;
  if (session.editable && result.has_thumbnail === false) {
    // imported drawings arrive without a preview; create one on first open
    uploadThumbnail(session, result.version, result.scene);
  }
  showStatus(
    session,
    session.error || (session.editable ? "Saved" : "Read only"),
  );
  if (session.pending && !session.error) {
    void flush(session);
  }
  if (
    node.ownerDocument.defaultView!.innerWidth >= 900 &&
    !node.ownerDocument.querySelector(".workspace-scenes-panel")
  ) {
    void showCollectionScenes(session);
  }
  return {
    // Deliberately no `scrollToContent`. It centres on a single element as
    // soon as the drawing is wider than the window, and it measures the window
    // before this sidebar has narrowed it — between the two, a saved drawing
    // opened on empty canvas with the work just off the edge. The editor fits
    // the whole drawing itself once it knows its real size; see
    // `useFitSavedDrawing` in excalidraw-app/App.tsx.
    elements: payload.elements,
    appState: {
      ...payload.appState,
      collaborators: new Map(),
      viewModeEnabled: !session.editable || Boolean(session.error),
    },
    files: payload.files,
  };
}
// Thumbnail failure never changes scene save success; version gates stale renders.
// The upload is kept on the session so leaving the editor can wait for it.
/** How long the drawing must sit still before a preview is worth rendering. */
const THUMBNAIL_IDLE_MS = 2500;

/**
 * Queues the dashboard preview instead of rendering it on the spot.
 *
 * `uploadThumbnail` draws the whole scene to a PNG, which on a drawing with a
 * dozen images is a fifth of a second of the main thread. It used to run on
 * every save — once a second while someone was drawing — so the canvas froze
 * at a steady beat, which is what made the editor feel as though something
 * else had hold of it. The preview is only ever looked at from the dashboard,
 * so it can wait for a pause.
 */
function scheduleThumbnail(
  session: EditorSession,
  version: number,
  scene: Payload,
) {
  session.thumbnailDue = { version, scene };
  if (session.thumbnailTimer) {
    clearTimeout(session.thumbnailTimer);
  }
  session.thumbnailTimer = setTimeout(
    () => renderDueThumbnail(session),
    THUMBNAIL_IDLE_MS,
  );
}

/** Renders a queued preview now — on the way out of the drawing, say. */
function renderDueThumbnail(session: EditorSession) {
  if (session.thumbnailTimer) {
    clearTimeout(session.thumbnailTimer);
    session.thumbnailTimer = undefined;
  }
  const due = session.thumbnailDue;
  if (!due) {
    return;
  }
  session.thumbnailDue = undefined;
  uploadThumbnail(session, due.version, due.scene);
}

function uploadThumbnail(
  session: EditorSession,
  version: number,
  scene: Payload,
) {
  const upload: Promise<void> = exportToBlob({
    elements: getNonDeletedElements(scene.elements),
    appState: { ...scene.appState, exportBackground: true },
    files: scene.files,
    mimeType: "image/png",
    maxWidthOrHeight: 480,
  })
    .then((blob) =>
      node.ownerDocument.defaultView!.fetch(
        `${API}/scenes/${session.id}/thumbnail?version=${version}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Excalidraw-Request": "1",
          },
          body: blob,
        },
      ),
    )
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (session.thumbnail === upload) {
        session.thumbnail = undefined;
      }
    });
  session.thumbnail = upload;
}
async function flush(session: EditorSession): Promise<void> {
  if (session.running) {
    await session.running;
    return;
  }
  // The scene is only turned into a payload here, so this has to run before
  // anything asks whether there is one.
  materialize(session);
  if (!session.pending || session.error || !session.loaded) {
    return;
  }
  if (session.timer) {
    clearTimeout(session.timer);
  }
  session.running = (async () => {
    while (session.pending && !session.error) {
      const pending = session.pending;
      const generation = session.generation;
      try {
        await draftStore("put", session.key, {
          key: session.key,
          version: session.version,
          scene: pending,
        });
        showStatus(session, "Saving…");
        const saved = await request<{
          version: number;
          scene?: Payload;
          merged?: boolean;
        }>(`/scenes/${session.id}/data`, {
          method: "PUT",
          body: JSON.stringify({
            version: session.version,
            scene: pending,
            room_id: node.ownerDocument.defaultView!.location.hash.match(
              /^#room=([a-zA-Z0-9_-]+),/,
            )?.[1],
          }),
        });
        session.version = saved.version;
        session.acknowledged = generation;
        // The server merges a save that was behind rather than refusing it, so
        // what is stored now holds other people's elements too. Adopt it.
        if (saved.merged && saved.scene && applyToCanvas) {
          session.current = JSON.stringify(
            scenePayload(
              saved.scene.elements,
              saved.scene.appState,
              saved.scene.files,
            ),
          );
          applyToCanvas(saved.scene);
          // The canvas has just had the stored copy reconciled into it, so
          // what was captured before that is no longer the whole of it.
          // Serialising it here would send a scene without the elements the
          // merge brought in and briefly store that. The change the apply
          // itself reports carries the real canvas, and becomes the next save.
          session.latest = undefined;
          session.signature = undefined;
        }
        // Whatever was drawn while that round trip was in the air is on the
        // canvas and in nothing else yet. Take it now, so the loop sends it
        // rather than ending and leaving it until the next stroke.
        materialize(session);
        if (session.pending === pending) {
          session.pending = undefined;
          await draftStore("delete", session.key);
          showStatus(session, "Saved");
        } else {
          await draftStore("put", session.key, {
            key: session.key,
            version: session.version,
            scene: session.pending,
          });
        }
        scheduleThumbnail(session, saved.version, saved.scene || pending);
      } catch (error: any) {
        session.error = error.message;
        showStatus(
          session,
          node.ownerDocument.defaultView!.navigator.onLine
            ? `Save failed: ${error.message}`
            : "Offline · draft retained on this device",
        );
      }
    }
  })();
  try {
    await session.running;
  } finally {
    session.running = undefined;
  }
}
// The data layer has no handle on the canvas, so the app registers one. It is
// used when the server merges a save: the copy being drawn on is then no longer
// what is stored, and without this the author would keep working from it and
// only discover the difference on reload.
type SceneApplier = (payload: Payload) => void;
let applyToCanvas: SceneApplier | undefined;
export const registerWorkspaceSceneApplier = (apply: SceneApplier) => {
  applyToCanvas = apply;
};

/**
 * Turns the scene last seen on the canvas into the payload that will be sent.
 *
 * This is the expensive half of saving: the drawing is serialised, and on one
 * with images that is every picture's bytes as base64. It used to run inside
 * `saveWorkspaceScene`, which the editor calls on every change — meaning once
 * per frame while a shape is being dragged. A drawing with a dozen icons was
 * stringified, compared and deep-copied sixty times a second, and the drawing
 * itself stuttered under it. The work has not changed; only when it runs. It
 * now happens once a pause, which is as often as a save can be sent anyway.
 */
function materialize(session: EditorSession) {
  const latest = session.latest;
  if (!latest) {
    return;
  }
  const { elements, appState, files } = latest;
  if (
    elements.some(
      (element) =>
        element.type === "image" &&
        !element.isDeleted &&
        (!element.fileId || !files[element.fileId]?.dataURL),
    )
  ) {
    // Still waiting on an image. Leave `latest` in place: the next change, or
    // the next flush, tries again once the bytes are there.
    showStatus(session, "Loading images…");
    return;
  }
  session.latest = undefined;
  const serialized = JSON.stringify(scenePayload(elements, appState, files));
  if (serialized === session.current) {
    // Nothing really changed — a selection, a scroll, or the canvas being
    // handed back the copy it just sent. Say so, or the bar reads "Saving…"
    // for ever.
    if (!session.pending && !session.error) {
      showStatus(session, "Saved");
    }
    return;
  }
  session.current = serialized;
  session.pending = JSON.parse(serialized);
  session.generation++;
  showStatus(
    session,
    session.error ? `Save failed: ${session.error}` : "Saving…",
  );
  void draftStore("put", session.key, {
    key: session.key,
    version: session.version,
    scene: session.pending!,
  }).catch(() =>
    showStatus(
      session,
      "Save failed: cannot retain a recovery draft. Keep this tab open.",
    ),
  );
}

export function saveWorkspaceScene(
  id: string,
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) {
  const session = sessions.get(id);
  if (
    !session?.loaded ||
    !session.editable ||
    appState.isLoading ||
    appState.viewModeEnabled
  ) {
    return;
  }
  // The editor reports a change for a selection, a scroll and a zoom as well
  // as an edit. Serialising the drawing to find that out is what this is
  // trying to avoid, so ask a question that can be answered by walking the
  // elements once: a hash of their nonces, which changes on any edit and on a
  // reorder, plus the few things outside them that are stored.
  const signature = `${elements.length}\u0000${hashElementsVersion(
    elements,
  )}\u0000${Object.keys(files).length}\u0000${
    appState.viewBackgroundColor
  }\u0000${appState.gridSize}\u0000${appState.gridStep}`;
  if (signature === session.signature) {
    return;
  }
  session.signature = signature;
  // Held by reference, not copied. Everything this costs is paid once, when
  // the save is actually made; see `materialize`.
  session.latest = { elements, appState, files };
  showStatus(
    session,
    session.error ? `Save failed: ${session.error}` : "Saving…",
  );
  if (session.timer) {
    clearTimeout(session.timer);
  }
  session.timer = setTimeout(() => void flush(session), 800);
}

export function workspaceEditorLocation() {
  return node?.ownerDocument.defaultView?.location;
}
export async function bindWorkspaceRoom(roomId: string, roomKey: string) {
  const id = getWorkspaceSceneId();
  if (id) {
    return request<{ roomId: string; roomKey: string }>(`/scenes/${id}/room`, {
      method: "POST",
      body: JSON.stringify({ room_id: roomId, room_key: roomKey }),
    });
  }
  return { roomId, roomKey };
}

export const getWorkspaceUserLabel = () => userLabel;

/**
 * Identifies the open drawing for the person who opened it — the same
 * `user:workspace:scene` key the draft store uses. Preferences keyed by it
 * belong to one person on one drawing, and never leak to anybody else.
 */
export const getWorkspaceSceneKey = () => active?.key ?? null;

export const workspaceEditorWindow = () => node?.ownerDocument.defaultView;
