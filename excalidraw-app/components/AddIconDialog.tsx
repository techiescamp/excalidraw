import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { useEffect, useRef, useState } from "react";

import "./AddIconDialog.scss";

import type { FormEvent } from "react";

const API = import.meta.env.VITE_APP_API_URL || "/api";

export const AddIconDialog = ({
  workspace,
  source,
  onClose,
  onSave,
}: {
  workspace: string;
  source: string;
  onClose: () => void;
  onSave: (name: string, category: string) => Promise<void>;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("General");
  const [categories, setCategories] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    const controller = new ownerWindow.AbortController();
    ownerWindow
      .fetch(`${API}/workspaces/${workspace}/icons?limit=1`, {
        credentials: "include",
        signal: controller.signal,
      })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Could not load icon categories.");
        }
        return (await response.json()) as { categories: string[] };
      })
      .then((result) => setCategories(result.categories))
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") {
          setCategories([]);
        }
      });
    return () => controller.abort();
  }, [workspace]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const safeName = name.trim();
    const safeCategory = category.trim();
    if (!safeName || !safeCategory) {
      setError("Enter a name and category for this icon.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(safeName, safeCategory);
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not save this icon.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog size="small" title="Add to icon library" onCloseRequest={onClose}>
      <div className="add-icon-dialog" ref={rootRef}>
        <p className="add-icon-dialog-hint">
          Save this selection for reuse anywhere in this workspace.
        </p>
        <div className="add-icon-dialog-preview-wrap">
          <img
            className="add-icon-dialog-preview"
            src={source}
            alt="Icon preview"
          />
        </div>
        <form className="add-icon-dialog-form" onSubmit={submit}>
          <label>
            Name
            <input
              autoComplete="off"
              autoFocus
              maxLength={80}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Category
            <input
              autoComplete="off"
              list="workspace-icon-categories"
              maxLength={40}
              required
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
            <datalist id="workspace-icon-categories">
              {categories.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
          {error && (
            <p className="add-icon-dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="add-icon-dialog-actions">
            <button
              type="button"
              className="add-icon-dialog-cancel"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="add-icon-dialog-save"
              disabled={saving}
            >
              {saving ? "Saving…" : "Add icon"}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
};
