import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import { encryptData, decryptData } from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ExcalidrawElement, FileId, OrderedExcalidrawElement }
  from "@excalidraw/element/types";
import type { AppState, BinaryFileData, BinaryFileMetadata, DataURL }
  from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";
import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";
import type { FirebaseStorage } from "firebase/storage";

const API = import.meta.env.VITE_APP_API_URL;

// "Export to Excalidraw+" uploads to the commercial hosted product's Firebase.
// It has no meaning on a self-hosted instance, so it fails with a clear message
// instead of silently misbehaving against an empty Firebase config.
export const loadFirebaseStorage = async (): Promise<FirebaseStorage> => {
  throw new Error(
    "Export to Excalidraw+ is unavailable on this self-hosted instance",
  );
};

const encryptElements = async (key: string, elements: readonly ExcalidrawElement[]) => {
  const encoded = new TextEncoder().encode(JSON.stringify(elements));
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(iv, ciphertext, roomKey);
  return JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(decrypted)));
};

// wire format: [2-byte IV length][IV][ciphertext]
const pack = (iv: Uint8Array, ciphertext: ArrayBuffer) => {
  const ct = new Uint8Array(ciphertext);
  const out = new Uint8Array(2 + iv.length + ct.length);
  new DataView(out.buffer).setUint16(0, iv.length);
  out.set(iv, 2);
  out.set(ct, 2 + iv.length);
  return out;
};

const unpack = (buf: ArrayBuffer) => {
  const all = new Uint8Array(buf);
  const ivLen = new DataView(buf).getUint16(0);
  return { iv: all.slice(2, 2 + ivLen), ciphertext: all.slice(2 + ivLen) };
};

const versionCache = new WeakMap<Socket, number>();

export const isSavedToFirebase = (
  portal: Portal, elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    return versionCache.get(portal.socket) === getSceneVersion(elements);
  }
  return true;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToFirebase(portal, elements)) {
    return null;
  }
  const existing = await loadFromFirebase(roomId, roomKey, socket);
  const reconciled = existing
    ? getSyncableElements(
        reconcileElements(
          elements,
          toBrandedType<RemoteExcalidrawElement[]>(
            existing as unknown as OrderedExcalidrawElement[],
          ),
          appState,
        ),
      )
    : elements;

  const { ciphertext, iv } = await encryptElements(roomKey, reconciled);
  const res = await fetch(`${API}/rooms/${roomId}/scene`, {
    method: "PUT",
    credentials: "include",
    headers: { "X-Excalidraw-Request": "1", "content-type": "application/octet-stream" },
    body: pack(iv, ciphertext),
  });
  if (!res.ok) { throw new Error(`scene save failed: ${res.status}`); }

  versionCache.set(socket, getSceneVersion(reconciled));
  // Collab.tsx feeds this straight into _reconcileElements()
  return toBrandedType<RemoteExcalidrawElement[]>(
    reconciled as unknown as OrderedExcalidrawElement[],
  );
};

export const loadFromFirebase = async (
  roomId: string, roomKey: string, socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const res = await fetch(`${API}/rooms/${roomId}/scene`, { credentials: "include" });
  if (res.status === 404) { return null; }
  if (!res.ok) { throw new Error(`scene load failed: ${res.status}`); }

  const { iv, ciphertext } = unpack(await res.arrayBuffer());
  const elements = getSyncableElements(
    restoreElements(await decryptElements(iv, ciphertext, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );
  if (socket) { versionCache.set(socket, getSceneVersion(elements)); }
  return elements;
};

export const saveFilesToFirebase = async ({
  prefix, files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const signed = await fetch(`${API}/files/upload-url`, {
          method: "POST",
          credentials: "include",
          headers: { "X-Excalidraw-Request": "1", "content-type": "application/json" },
          body: JSON.stringify({
            prefix: prefix.replace(/^\//, ""),
            file_id: id,
            mime_type: MIME_TYPES.binary,
          }),
        }).then((r) => r.json());

        const put = await fetch(signed.url, {
          credentials: "include",
          method: "PUT",
          headers: { "X-Excalidraw-Request": "1", "content-type": MIME_TYPES.binary },
          body: new Blob(
            [
              buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + buffer.byteLength,
              ) as ArrayBuffer,
            ],
            { type: MIME_TYPES.binary },
          ),
        });
        if (!put.ok) { throw new Error(String(put.status)); }
        savedFiles.push(id);
      } catch (error: any) {
        console.error(error);
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromFirebase = async (
  prefix: string, decryptionKey: string, filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const path = prefix.replace(/^\/?(files\/)?/, "");
        const response = await fetch(`${API}/files/${path}/${id}`, {
          credentials: "include",
        });
        if (response.status >= 400) { erroredFiles.set(id, true); return; }

        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(await response.arrayBuffer()),
          { decryptionKey },
        );
        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL: new TextDecoder().decode(data) as DataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
