import {
  DefaultSidebar,
  Sidebar,
  THEME,
  CaptureUpdateAction,
  useExcalidrawAPI,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import {
  ImageIcon,
  messageCircleIcon,
  presentationIcon,
} from "@excalidraw/excalidraw/components/icons";
import { LinkButton } from "@excalidraw/excalidraw/components/LinkButton";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { newImageElement } from "@excalidraw/element";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import {
  getActiveWorkspaceId,
  subscribeActiveWorkspace,
} from "../data/workspaceScene";

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

  const insertIcon = async (icon: WorkspaceIcon) => {
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
      const imageSize = 128;
      const appState = excalidrawAPI.getAppState();
      const center = viewportCoordsToSceneCoords(
        {
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
            x: center.x - imageSize / 2,
            y: center.y - imageSize / 2,
            width: imageSize,
            height: imageSize,
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
                title={reference}
                aria-label={`Select ${icon.display_name || reference}`}
                aria-pressed={selected === reference}
                className={`app-icon-library-item${
                  selected === reference ? " is-selected" : ""
                }`}
                disabled={
                  inserting !== "" ||
                  !!excalidrawAPI?.getAppState().viewModeEnabled
                }
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
                <span>{icon.display_name || icon.name}</span>
                <small>{icon.category}</small>
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
        </div>
      )}
    </div>
  );
};

type SidebarPromoCopyProps = {
  text: string;
};

const SidebarPromoCopy = (props: SidebarPromoCopyProps) => {
  return (
    <div className="app-sidebar-promo-copy">
      <div className="app-sidebar-promo-illustration" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 300 250"
          className="app-sidebar-promo-heart"
        >
          <path
            d="M 145 75
           C 110 35, 60 55, 65 120
           C 70 180, 140 190, 215 200
           C 225 180, 260 110, 235 55
           C 210 -5, 140 20, 160 105"
            fill="none"
            stroke="#D06B64"
            strokeWidth="16"
            strokeLinecap="round"
          />
        </svg>

        <div className="app-sidebar-promo-trial-note excalifont">
          14 days of
          <br />
          free trial
        </div>
        <svg
          className="app-sidebar-promo-trial-arrow"
          viewBox="0 0 72 48"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M5 6C23 1 50 8 48 32"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M42 26L48 32L54 26"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="app-sidebar-promo-text">{props.text}</div>
    </div>
  );
};

export const AppSidebar = () => {
  const { theme, openSidebar } = useUIAppState();
  const activeWorkspace = useSyncExternalStore(
    subscribeActiveWorkspace,
    getActiveWorkspaceId,
    getActiveWorkspaceId,
  );

  return (
    <DefaultSidebar>
      <DefaultSidebar.TabTriggers>
        <Sidebar.TabTrigger
          tab="comments"
          style={{ opacity: openSidebar?.tab === "comments" ? 1 : 0.4 }}
        >
          {messageCircleIcon}
        </Sidebar.TabTrigger>
        <Sidebar.TabTrigger
          tab="presentation"
          style={{ opacity: openSidebar?.tab === "presentation" ? 1 : 0.4 }}
        >
          {presentationIcon}
        </Sidebar.TabTrigger>
        {activeWorkspace && (
          <Sidebar.TabTrigger
            tab="icons"
            aria-label="Icons"
            title="Icons"
            style={{ opacity: openSidebar?.tab === "icons" ? 1 : 0.4 }}
          >
            {ImageIcon}
          </Sidebar.TabTrigger>
        )}
      </DefaultSidebar.TabTriggers>
      <Sidebar.Tab tab="comments">
        <div className="app-sidebar-promo-container">
          <div
            className="app-sidebar-promo-image"
            style={{
              ["--image-source" as any]: `url(/sidebar-comments-promo-${
                theme === THEME.DARK ? "dark" : "light"
              }.jpg)`,
              opacity: 0.9,
            }}
          />
          <SidebarPromoCopy text="Make comments with Excalidraw+" />
          <LinkButton
            href={`${
              import.meta.env.VITE_APP_PLUS_LP
            }/plus?utm_source=excalidraw&utm_medium=app&utm_content=comments_promo#excalidraw-redirect`}
          >
            Sign up now
          </LinkButton>
        </div>
      </Sidebar.Tab>
      <Sidebar.Tab tab="presentation" className="px-3">
        <div className="app-sidebar-promo-container">
          <div
            className="app-sidebar-promo-image"
            style={{
              ["--image-source" as any]: `url(/sidebar-presentation-promo-${
                theme === THEME.DARK ? "dark" : "light"
              }.jpg)`,
              opacity: 0.7,
            }}
          />
          <SidebarPromoCopy text="Create presentation with Excalidraw+" />
          <LinkButton
            href={`${
              import.meta.env.VITE_APP_PLUS_LP
            }/plus?utm_source=excalidraw&utm_medium=app&utm_content=presentations_promo#excalidraw-redirect`}
          >
            Sign up now
          </LinkButton>
        </div>
      </Sidebar.Tab>
      {activeWorkspace && (
        <Sidebar.Tab tab="icons" className="px-3">
          <IconLibrary workspace={activeWorkspace} />
        </Sidebar.Tab>
      )}
    </DefaultSidebar>
  );
};
