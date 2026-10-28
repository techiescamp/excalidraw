import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSnapPreference,
  writeSnapPreference,
} from "../data/snapPreference";

const KEY = "user-1:workspace-1:scene-1";

// A private window, blocked site data or a full store: every access throws.
const withBrokenStorage = (body: () => void) => {
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");
  const refuse = () => {
    throw new Error("storage unavailable");
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => ({ getItem: refuse, setItem: refuse }),
  });
  try {
    body();
  } finally {
    if (real) {
      Object.defineProperty(window, "localStorage", real);
    }
  }
};

describe("snap preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("says nothing when the person has never chosen", () => {
    expect(readSnapPreference(KEY)).toBe(null);
  });

  it("remembers both answers", () => {
    writeSnapPreference(KEY, true);
    expect(readSnapPreference(KEY)).toBe(true);
    writeSnapPreference(KEY, false);
    expect(readSnapPreference(KEY)).toBe(false);
  });

  it("keeps one drawing's answer off another drawing", () => {
    writeSnapPreference("user-1:workspace-1:scene-a", true);
    expect(readSnapPreference("user-1:workspace-1:scene-b")).toBe(null);
  });

  it("keeps one person's answer off another person", () => {
    // Two accounts on one machine must not inherit each other's setting.
    writeSnapPreference("user-1:workspace-1:scene-1", true);
    expect(readSnapPreference("user-2:workspace-1:scene-1")).toBe(null);
  });

  it("does nothing without a drawing to attach the answer to", () => {
    expect(readSnapPreference(null)).toBe(null);
    expect(() => writeSnapPreference(null, true)).not.toThrow();
    expect(window.localStorage.length).toBe(0);
  });

  it("falls back to the editor's default when storage cannot be read", () => {
    withBrokenStorage(() => {
      expect(readSnapPreference(KEY)).toBe(null);
    });
  });

  it("survives storage that refuses to write", () => {
    // A full or blocked store must not take the editor down mid-drag.
    withBrokenStorage(() => {
      expect(() => writeSnapPreference(KEY, true)).not.toThrow();
    });
  });
});
