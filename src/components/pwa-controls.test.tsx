// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PwaControls } from "./pwa-controls";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function offerUpdate(postMessage: ReturnType<typeof vi.fn>) {
  window.dispatchEvent(new CustomEvent("kcalcue-update", {
    detail: { state: "installed", postMessage } as unknown as ServiceWorker,
  }));
}

it("does not activate a waiting service worker when draft durability fails", async () => {
  const postMessage = vi.fn();
  const beforeUpdate = vi.fn().mockRejectedValue(new Error("IndexedDB unavailable"));
  render(<PwaControls visible={false} beforeUpdate={beforeUpdate} />);
  offerUpdate(postMessage);
  fireEvent.click(await screen.findByRole("button", { name: "保存草稿並更新" }));
  expect(await screen.findByText("草稿未能保存，請先儲存或放棄修改後再更新。"))
    .toBeVisible();
  expect(beforeUpdate).toHaveBeenCalledTimes(1);
  expect(postMessage).not.toHaveBeenCalled();
});

it("activates a waiting service worker only after draft durability succeeds", async () => {
  const postMessage = vi.fn();
  const beforeUpdate = vi.fn().mockResolvedValue(undefined);
  render(<PwaControls visible={false} beforeUpdate={beforeUpdate} />);
  offerUpdate(postMessage);
  fireEvent.click(await screen.findByRole("button", { name: "保存草稿並更新" }));
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "ACTIVATE_UPDATE" }));
  expect(beforeUpdate).toHaveBeenCalledTimes(1);
  expect(screen.getByText("草稿已保留，正在更新…")).toBeVisible();
});
