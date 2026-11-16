// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";

import { readSidebarCollapsed, readTheme, saveSidebarCollapsed, saveTheme } from "./preferences";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("remembers the theme and applies the resolved mode to the page", () => {
  expect(readTheme()).toBe("system");
  saveTheme("dark");
  expect(readTheme()).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  saveTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  saveTheme("system");
  expect(readTheme()).toBe("system");
});

it("keeps working when storage throws", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  saveTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(readTheme()).toBe("system");
  saveSidebarCollapsed(true);
  expect(readSidebarCollapsed()).toBe(false);
});
