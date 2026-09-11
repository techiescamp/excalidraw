import "./workspaceScene.css";
import { getNonDeletedElements } from "@excalidraw/element";
import { exportToBlob } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

const API = import.meta.env.VITE_APP_API_URL || "/api";
type Payload = {
  type: string;
  version: number;
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};
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
  pending?: Payload;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  error?: string;
  generation: number;
  acknowledged: number;
  renaming?: boolean;
};
let node: HTMLElement;
let status: HTMLElement;
let userId = "";
let userLabel = "Account";
let permissions: Record<string, boolean> | null = null;
const listeners = new Set<() => void>();
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
  return response.json();
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
  if (session.renaming) {
    // an inline rename is in progress: refresh only the status text so the
    // input being typed into is not torn down by an autosave tick
    const message = status.querySelector('[role="status"]');
    if (message) {
      message.textContent = text;
      return;
    }
  }
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
function startInlineRename(
  session: EditorSession,
  title: HTMLButtonElement,
) {
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
async function showCollectionScenes(session: EditorSession) {
  const doc = node.ownerDocument,
    old = doc.querySelector(".workspace-scenes-panel");
  if (old) {
    old.remove();
    doc.documentElement.classList.remove("workspace-sidebar-open");
    return;
  }
  const panel = doc.createElement("aside");
  panel.className = "workspace-scenes-panel";
  panel.setAttribute("aria-label", "Collection scenes");
  const heading = doc.createElement("h2"),
    close = doc.createElement("button"),
    list = doc.createElement("nav");
  heading.textContent = "Collection scenes";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close scene list");
  close.className = "workspace-panel-close";
  close.onclick = () => {
    panel.remove();
    doc.documentElement.classList.remove("workspace-sidebar-open");
  };
  panel.append(close, heading, list);
  doc.body.append(panel);
  doc.documentElement.classList.add("workspace-sidebar-open");
  const context = new URL(session.returnTo, doc.defaultView!.location.origin)
      .searchParams,
    query = new URLSearchParams({
      workspace: session.workspace,
      limit: "100",
      sort: "title",
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
  list.textContent = "Loading…";
  try {
    const [result, workspaces] = await Promise.all([
      request<{
        items: Array<{
          id: string;
          name: string;
          thumb_s3_key?: string;
          scene_version: number;
          owner_name: string;
          collections: Array<{ id: string; name: string }>;
        }>;
        total: number;
      }>(`/scenes?${query}`),
      request<Array<{ id: string; name: string }>>("/workspaces"),
    ]);
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
    if (!panel.isConnected) return;
    list.replaceChildren();
    for (const scene of result.items) {
      const link = doc.createElement("a");
      link.href = `/editor?scene=${scene.id}&returnTo=${encodeURIComponent(
        session.returnTo,
      )}`;
      const caption = doc.createElement("span"),
        label = doc.createElement("strong"),
        author = doc.createElement("small");
      label.textContent = scene.name;
      author.textContent = `by ${scene.owner_name}`;
      caption.append(label, author);
      if (scene.thumb_s3_key) {
        const image = doc.createElement("img");
        image.src = `${API}/scenes/${scene.id}/thumbnail?v=${scene.scene_version}`;
        image.alt = "";
        link.append(image);
      }
      link.append(caption);
      link.dataset.sceneName = scene.name.toLowerCase();
      if (scene.id === session.id) link.setAttribute("aria-current", "page");
      list.append(link);
    }
    search.oninput = () =>
      list
        .querySelectorAll<HTMLAnchorElement>("[data-scene-name]")
        .forEach(
          (link) =>
            (link.hidden = !link.dataset.sceneName!.includes(
              search.value.toLowerCase(),
            )),
        );
    if (result.total > 100) {
      const more = doc.createElement("a");
      more.href = session.returnTo;
      more.textContent = `View all ${result.total} scenes`;
      list.append(more);
    }
    if (permissions?.["drawing.create"]) {
      const create = doc.createElement("button");
      create.textContent = "+ Create scene";
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
          create.textContent = e.message;
          create.disabled = false;
        }
      };
      panel.insertBefore(create, list);
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
  const doc = node.ownerDocument,
    win = doc.defaultView!;
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
    }
  });
  win.addEventListener("online", () => {
    if (active?.pending && !active.error?.includes("changed")) {
      active.error = undefined;
      void flush(active);
    }
  });
  win.addEventListener("beforeunload", (event) => {
    if (active?.pending || active?.running) {
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
        !active?.pending ||
        anchor.origin !== win.location.origin ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      await flush(active);
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
  if (requestedRoom && requestedRoom !== result.room_id) {
    ownerWindow.history.replaceState(
      {},
      "",
      ownerWindow.location.pathname + ownerWindow.location.search,
    );
  }
  if (result.collaboration) {
    ownerWindow.history.replaceState(
      {},
      "",
      `${ownerWindow.location.pathname}${ownerWindow.location.search}#room=${result.collaboration.roomId},${result.collaboration.roomKey}`,
    );
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
  sessions.set(id, session);
  let payload = result.scene;
  const draft = await draftStore("get", session.key);
  if (draft && session.editable) {
    // A conflict is never uploaded implicitly. Keep the server canvas until the user chooses a copy.
    session.pending = draft.scene;
    if (
      draft.version === result.version &&
      node.ownerDocument.defaultView!.confirm(
        "A recoverable unsaved draft exists for this drawing. Restore it?",
      )
    ) {
      payload = draft.scene;
    } else {
      session.error =
        draft.version !== result.version
          ? "Drawing changed on the server. Save your draft as a copy or reload."
          : "Recovery draft retained. Save it as a copy or reload to discard it.";
    }
  }
  session.current = JSON.stringify(
    scenePayload(payload.elements, payload.appState, payload.files),
  );
  session.loaded = true;
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
    scrollToContent: true,
    elements: payload.elements,
    appState: {
      ...payload.appState,
      collaborators: new Map(),
      viewModeEnabled: !session.editable || Boolean(session.error),
    },
    files: payload.files,
  };
}
async function flush(session: EditorSession): Promise<void> {
  if (session.running) {
    await session.running;
    return;
  }
  if (!session.pending || session.error || !session.loaded) {
    return;
  }
  if (session.timer) {
    clearTimeout(session.timer);
  }
  session.running = (async () => {
    while (session.pending && !session.error) {
      const pending = session.pending,
        generation = session.generation;
      try {
        await draftStore("put", session.key, {
          key: session.key,
          version: session.version,
          scene: pending,
        });
        showStatus(session, "Saving…");
        const saved = await request<{ version: number; scene?: Payload }>(
          `/scenes/${session.id}/data`,
          {
            method: "PUT",
            body: JSON.stringify({
              version: session.version,
              scene: pending,
              room_id: node.ownerDocument.defaultView!.location.hash.match(
                /^#room=([a-zA-Z0-9_-]+),/,
              )?.[1],
            }),
          },
        );
        session.version = saved.version;
        session.acknowledged = generation;
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
        // Thumbnail failure never changes scene save success; version gates stale renders.
        void exportToBlob({
          elements: getNonDeletedElements((saved.scene || pending).elements),
          appState: { ...pending.appState, exportBackground: true },
          files: (saved.scene || pending).files,
          mimeType: "image/png",
          maxWidthOrHeight: 480,
        })
          .then((blob) =>
            node.ownerDocument.defaultView!.fetch(
              `${API}/scenes/${session.id}/thumbnail?version=${saved.version}`,
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
          .catch(() => {});
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
  if (
    elements.some(
      (element) =>
        element.type === "image" &&
        !element.isDeleted &&
        (!element.fileId || !files[element.fileId]?.dataURL),
    )
  ) {
    showStatus(session, "Loading images…");
    return;
  }
  const payload = scenePayload(elements, appState, files),
    serialized = JSON.stringify(payload);
  if (serialized === session.current) {
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
  if (id)
    return request<{ roomId: string; roomKey: string }>(`/scenes/${id}/room`, {
      method: "POST",
      body: JSON.stringify({ room_id: roomId, room_key: roomKey }),
    });
  return { roomId, roomKey };
}

export const getWorkspaceUserLabel = () => userLabel;

export const workspaceEditorWindow = () => node?.ownerDocument.defaultView;
