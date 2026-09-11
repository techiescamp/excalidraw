import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";
import { initializeWorkspaceEditor } from "./data/workspaceScene";

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
const ownerWindow = rootElement.ownerDocument.defaultView!;
async function start() {
  if (import.meta.env.VITE_APP_API_URL) {
    const response = await ownerWindow.fetch(
      `${import.meta.env.VITE_APP_API_URL}/me`,
      { credentials: "include" },
    );
    if (!response.ok) {
      ownerWindow.location.replace("/login");
      return;
    }
    const user = await response.json();
    if (!new URLSearchParams(ownerWindow.location.search).get("scene")) {
      ownerWindow.location.replace("/dashboard");
      return;
    }
    initializeWorkspaceEditor(
      rootElement,
      user.id,
      user.display_name || user.username,
    );
  } else {
    registerSW();
  }
  root.render(
    <StrictMode>
      <ExcalidrawApp />
    </StrictMode>,
  );
}
void start().catch(() => {
  rootElement.textContent =
    "Cannot connect to the server. Refresh to try again.";
});
