import {
  DefaultSidebar,
  Sidebar,
  CaptureUpdateAction,
  useExcalidrawAPI,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import { ImageIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { newImageElement } from "@excalidraw/element";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import {
  getActiveWorkspaceId,
  subscribeActiveWorkspace,
} from "../data/workspaceScene";
import { fitIconSize } from "../data/iconSize";

import "./AppSidebar.scss";

const API = import.meta.env.VITE_APP_API_URL || "/api";
type WorkspaceIcon = {
  set_name: string;
  name: string;
  display_name: string | null;
  category: string;
  mime: string;
  source: string | null;
  license: string | null;
};

const IconLibrary = ({ workspace }: { workspace: string }) => {
  const excalidrawAPI = useExcalidrawAPI();
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [icons, setIcons] = useState<WorkspaceIcon[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    reference: string;
    x: number;
    y: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inserting, setInserting] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    const ownerWindow = panelRef.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    const refresh = () => setRefreshCount((current) => current + 1);
    ownerWindow.addEventListener("workspace-icons-updated", refresh);
    return () =>
      ownerWindow.removeEventListener("workspace-icons-updated", refresh);
  }, []);

  useEffect(() => {
    const ownerWindow = panelRef.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    const controller = new ownerWindow.AbortController();
    setLoading(true);
    setError("");
    ownerWindow
      .fetch(
        `${API}/workspaces/${workspace}/icons?q=${encodeURIComponent(
          query,
        )}&category=${encodeURIComponent(category)}&limit=300`,
        {
          credentials: "include",
          signal: controller.signal,
        },
      )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Could not load this workspace's icons.");
        }
        return (await response.json()) as {
          icons: WorkspaceIcon[];
          categories: string[];
        };
      })
      .then((result) => {
        setIcons(result.icons);
        setCategories(result.categories);
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") {
          setError(reason.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [category, query, refreshCount, workspace]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const panel = panelRef.current;
    const ownerDocument = panel?.ownerDocument;
    if (!ownerDocument) {
      return;
    }
    const dismiss = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    ownerDocument.addEventListener("pointerdown", dismiss);
    ownerDocument.addEventListener("keydown", onKeyDown);
    return () => {
      ownerDocument.removeEventListener("pointerdown", dismiss);
      ownerDocument.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  // Dragging an icon onto the canvas is the first thing anyone tries, so the
  // drop is handled here rather than leaving the button as the only way in.
  const dragging = useRef<WorkspaceIcon | null>(null);

  useEffect(() => {
    const ownerDocument = panelRef.current?.ownerDocument;
    if (!ownerDocument) {
      return;
    }
    const allowDrop = (event: DragEvent) => {
      if (!dragging.current) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (event: DragEvent) => {
      const icon = dragging.current;
      const target = event.target as HTMLElement | null;
      // Only a drop on the canvas counts; one back onto the panel is a miss.
      if (!icon || !target?.closest?.(".excalidraw")) {
        return;
      }
      // Taken in the capture phase, before the editor's own file drop handler
      // sees an event it has no file for.
      event.preventDefault();
      event.stopPropagation();
      dragging.current = null;
      void insertIcon(icon, { clientX: event.clientX, clientY: event.clientY });
    };
    ownerDocument.addEventListener("dragover", allowDrop, true);
    ownerDocument.addEventListener("drop", onDrop, true);
    return () => {
      ownerDocument.removeEventListener("dragover", allowDrop, true);
      ownerDocument.removeEventListener("drop", onDrop, true);
    };
  });

  const removeIcon = async (icon: WorkspaceIcon) => {
    const ownerWindow = panelRef.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    // The library is shared, so this takes the icon away from everyone. Worth
    // asking before, not explaining after.
    if (
      !ownerWindow.confirm(
        `Delete "${
          icon.display_name || icon.name
        }" from the icon library? Everyone loses it.`,
      )
    ) {
      return;
    }
    try {
      const response = await ownerWindow.fetch(
        `${API}/workspaces/${workspace}/icons/${encodeURIComponent(
          icon.set_name,
        )}/${encodeURIComponent(icon.name)}`,
        {
          method: "DELETE",
          credentials: "include",
          // The API rejects a write that arrives without this header as
          // cross-site, so without it deleting an icon only ever failed.
          headers: { "X-Excalidraw-Request": "1" },
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Could not delete this icon.");
      }
      setSelected("");
      setRefreshCount((current) => current + 1);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const insertIcon = async (
    icon: WorkspaceIcon,
    at?: { clientX: number; clientY: number },
  ) => {
    const panel = panelRef.current;
    const ownerWindow = panel?.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !excalidrawAPI ||
      excalidrawAPI.getAppState().viewModeEnabled
    ) {
      return;
    }
    const reference = `${icon.set_name}/${icon.name}`;
    setInserting(reference);
    setError("");
    try {
      const response = await ownerWindow.fetch(
        `${API}/workspaces/${workspace}/icons/${encodeURIComponent(
          icon.set_name,
        )}/${encodeURIComponent(icon.name)}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`Could not load ${reference}.`);
      }
      const file = await response.blob();
      const dataURL = await new Promise<DataURL>((resolve, reject) => {
        const reader = new ownerWindow.FileReader();
        reader.onload = () => resolve(reader.result as DataURL);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const random = ownerWindow.crypto.getRandomValues(new Uint8Array(20));
      const fileId = Array.from(random, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("") as FileId;
      const natural = await new Promise<{ width: number; height: number }>(
        (resolve) => {
          const probe = new ownerWindow.Image();
          probe.onload = () =>
            resolve({
              width: probe.naturalWidth || probe.width,
              height: probe.naturalHeight || probe.height,
            });
          // An SVG without an intrinsic size reports nothing useful, and
          // fitIconSize falls back to a square for it.
          probe.onerror = () => resolve({ width: 0, height: 0 });
          probe.src = dataURL;
        },
      );
      const { width, height } = fitIconSize(natural);
      const appState = excalidrawAPI.getAppState();
      // Dropped where the pointer let go; clicked, in the middle of the view.
      const center = viewportCoordsToSceneCoords(
        at ?? {
          clientX: appState.offsetLeft + appState.width / 2,
          clientY: appState.offsetTop + appState.height / 2,
        },
        appState,
      );
      excalidrawAPI.addFiles([
        {
          id: fileId,
          mimeType: (file.type || icon.mime) as BinaryFiles[string]["mimeType"],
          dataURL,
          created: Date.now(),
        },
      ]);
      excalidrawAPI.updateScene({
        elements: [
          ...excalidrawAPI.getSceneElementsIncludingDeleted(),
          newImageElement({
            type: "image",
            x: center.x - width / 2,
            y: center.y - height / 2,
            width,
            height,
            fileId,
            status: "saved",
          }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not insert that icon.",
      );
    } finally {
      setInserting("");
    }
  };

  return (
    <div className="app-icon-library" ref={panelRef}>
      <div className="app-icon-library-header">
        <div>
          <h2>Workspace icons</h2>
          <p>Select an icon below to add it to your canvas.</p>
        </div>
        {!loading && !error && (
          <span className="app-icon-library-count">{icons.length}</span>
        )}
      </div>
      <div className="app-icon-library-toolbar">
        <select
          aria-label="Filter icons by category"
          value={category}
          onChange={(event) => {
            setSelected("");
            setCategory(event.target.value);
          }}
        >
          <option value="">All categories</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="app-icon-library-add"
          disabled={
            !selected ||
            inserting !== "" ||
            !!excalidrawAPI?.getAppState().viewModeEnabled
          }
          onClick={() => {
            const icon = icons.find(
              (item) => `${item.set_name}/${item.name}` === selected,
            );
            if (icon) {
              setContextMenu(null);
              void insertIcon(icon);
            }
          }}
        >
          Add to canvas
        </button>
      </div>
      <input
        className="app-icon-library-search"
        type="search"
        aria-label="Search workspace icons"
        value={query}
        onChange={(event) => {
          setSelected("");
          setQuery(event.target.value);
        }}
        placeholder="Search icons"
      />
      {selected && (
        <div className="app-icon-library-selection">
          Selected:{" "}
          {icons.find((item) => `${item.set_name}/${item.name}` === selected)
            ?.display_name || selected}
        </div>
      )}
      {error && <div className="app-icon-library-message">{error}</div>}
      {loading ? (
        <div className="app-icon-library-message">Loading icons…</div>
      ) : icons.length ? (
        <div className="app-icon-library-grid">
          {icons.map((icon) => {
            const reference = `${icon.set_name}/${icon.name}`;
            return (
              <button
                type="button"
                key={reference}
                // The tile shows the picture alone, so the name lives here
                // and in the label rather than under every icon.
                title={icon.display_name || reference}
                aria-label={`Select ${icon.display_name || reference}`}
                aria-pressed={selected === reference}
                className={`app-icon-library-item${
                  selected === reference ? " is-selected" : ""
                }`}
                disabled={
                  inserting !== "" ||
                  !!excalidrawAPI?.getAppState().viewModeEnabled
                }
                draggable={!excalidrawAPI?.getAppState().viewModeEnabled}
                onDragStart={(event) => {
                  dragging.current = icon;
                  setSelected(reference);
                  // Some browsers cancel a drag that carries nothing.
                  event.dataTransfer.setData("text/plain", reference);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={() => {
                  dragging.current = null;
                }}
                onClick={() => setSelected(reference)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const panel = panelRef.current;
                  if (!panel) {
                    return;
                  }
                  const bounds = panel.getBoundingClientRect();
                  setSelected(reference);
                  setContextMenu({
                    reference,
                    x: Math.max(
                      4,
                      Math.min(event.clientX - bounds.left, bounds.width - 160),
                    ),
                    y: Math.max(
                      4,
                      Math.min(event.clientY - bounds.top, bounds.height - 48),
                    ),
                  });
                }}
              >
                <img
                  src={`${API}/workspaces/${workspace}/icons/${encodeURIComponent(
                    icon.set_name,
                  )}/${encodeURIComponent(icon.name)}`}
                  alt=""
                  loading="lazy"
                />
              </button>
            );
          })}
        </div>
      ) : (
        !error && (
          <div className="app-icon-library-message">
            {query
              ? "No matching icons in this workspace."
              : "No icons saved yet. Select an image on the canvas, right-click it, and choose Add image to icon library."}
          </div>
        )
      )}
      {contextMenu && (
        <div
          className="app-icon-library-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={inserting !== ""}
            onClick={() => {
              const icon = icons.find(
                (item) =>
                  `${item.set_name}/${item.name}` === contextMenu.reference,
              );
              setContextMenu(null);
              if (icon) {
                void insertIcon(icon);
              }
            }}
          >
            Add to canvas
          </button>
          <button
            type="button"
            role="menuitem"
            className="app-icon-library-delete"
            onClick={() => {
              const icon = icons.find(
                (item) =>
                  `${item.set_name}/${item.name}` === contextMenu.reference,
              );
              setContextMenu(null);
              if (icon) {
                void removeIcon(icon);
              }
            }}
          >
            Delete from library
          </button>
        </div>
      )}
    </div>
  );
};

export const AppSidebar = () => {
  const { openSidebar } = useUIAppState();
  const activeWorkspace = useSyncExternalStore(
    subscribeActiveWorkspace,
    getActiveWorkspaceId,
    getActiveWorkspaceId,
  );

  return (
    <DefaultSidebar>
      {/* The sidebar used to lead with two Excalidraw+ adverts, so the icon
          library — the only tab that does anything here — sat third and had to
          be hunted for. This install cannot buy Excalidraw+, so the adverts
          are gone and the panel opens on the icons. */}
      {activeWorkspace && (
        <>
          <DefaultSidebar.TabTriggers>
            <Sidebar.TabTrigger
              tab="icons"
              aria-label="Icons"
              title="Icons"
              style={{ opacity: openSidebar?.tab === "icons" ? 1 : 0.4 }}
            >
              {ImageIcon}
            </Sidebar.TabTrigger>
          </DefaultSidebar.TabTriggers>
          <Sidebar.Tab tab="icons" className="px-3">
            <IconLibrary workspace={activeWorkspace} />
          </Sidebar.Tab>
        </>
      )}
    </DefaultSidebar>
  );
};
