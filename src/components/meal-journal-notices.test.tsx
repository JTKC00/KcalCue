// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { newDraft, type MealDraft, type MealRecord } from "@/lib/meals/types";
import { visibleMeals, type SyncState } from "@/lib/meals/outbox";
import type { LocalMeals } from "@/lib/meals/cache";

const fixture = vi.hoisted(() => ({
  callback: null as null | ((user: { uid: string; email: string }) => void),
  list: vi.fn(), state: vi.fn(), sync: vi.fn(), remove: vi.fn(), save: vi.fn(),
  read: vi.fn(), write: vi.fn(), snapshot: vi.fn(), clear: vi.fn(),
}));
vi.mock("@/lib/firebase/client", () => ({
  cloudConfigured: () => true,
  hasEmailLink: () => false,
  signOut: vi.fn(),
  firebaseAuth: () => ({ currentUser: { uid: "notice-user" } }),
  onAuthStateChanged: (_auth: unknown, callback: typeof fixture.callback) => {
    fixture.callback = callback;
    return () => {};
  },
}));
vi.mock("@/lib/meals/repository", () => ({
  RepositoryError: class extends Error {},
  MealRepository: class {
    list = fixture.list;
    state = fixture.state;
    sync = fixture.sync;
    delete = fixture.remove;
    save = fixture.save;
  },
}));
vi.mock("@/lib/meals/cache", () => ({
  draftTabId: () => "test-tab",
  prepareDraftTabId: async () => "test-tab",
  localMeals: {
    read: fixture.read, write: fixture.write,
    writeSnapshot: fixture.snapshot, clear: fixture.clear,
    listDrafts: async () => [], restoreDraft: vi.fn(),
  },
}));
vi.mock("./kcalcue-app", () => ({ KcalCueApp: () => null }));
vi.mock("./pwa-controls", () => ({ PwaControls: () => null }));
vi.mock("./firebase-account", () => ({ Account: () => null }));
import { MealJournal } from "./meal-journal";

const deleteNotice = "刪除已保留於本機，連線時自動同步。";
const pendingNotice = (count: number) => `已保留本機修改，尚有 ${count} 項待同步。`;
const localAcknowledgement = /^(刪除已保留於本機，連線時自動同步。|已儲存到本機，連線時會自動同步。圖片不會保存到雲端。|已保留本機修改，尚有 \d+ 項待同步。)$/;
const storageNotice = "本機空間不足或儲存不可用，草稿未能保留。請先儲存到雲端。";
let state: SyncState;
let cache: LocalMeals;
const emptyState = (): SyncState => ({ remote: [], jobs: [], syncedAt: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function record(name = "測試餐點"): MealRecord {
  return {
    ...newDraft(), userId: "notice-user", version: 1,
    mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString(),
    items: [{ ...createEditableFoodItems(demoFoodAnalysis.foods)[0], displayName: name }],
  };
}
async function start() {
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => { fixture.callback!({ uid: "notice-user", email: "test@example.com" }); });
  await waitFor(() => expect(fixture.state).toHaveBeenCalledTimes(2));
}
async function refresh() {
  const calls = fixture.state.mock.calls.length;
  await act(async () => { window.dispatchEvent(new Event("kcalcue-sync")); });
  await waitFor(() => expect(fixture.state).toHaveBeenCalledTimes(calls + 1));
}
async function removeMeal() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刪除" })); });
  await screen.findByText(localAcknowledgement);
  await screen.findByText(/1 項修改待同步/);
}

beforeEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const mock of [fixture.list, fixture.state, fixture.sync, fixture.remove, fixture.save, fixture.read, fixture.write, fixture.snapshot, fixture.clear]) mock.mockReset();
  state = emptyState();
  cache = { records: [], draft: null, syncedAt: null };
  fixture.list.mockImplementation(async () => visibleMeals(structuredClone(state)));
  fixture.state.mockImplementation(async () => structuredClone(state));
  fixture.sync.mockResolvedValue(undefined);
  fixture.read.mockImplementation(async () => structuredClone(cache));
  fixture.write.mockImplementation(async (_uid: string, value: LocalMeals) => { cache = structuredClone(value); });
  fixture.snapshot.mockImplementation(async (_uid: string, value: Pick<LocalMeals, "records" | "syncedAt">) => {
    cache = { ...cache, ...structuredClone(value) };
  });
  fixture.clear.mockResolvedValue(undefined);
  fixture.remove.mockImplementation(async (meal: MealRecord) => {
    state.jobs.push({ id: crypto.randomUUID(), kind: "delete", record: meal, expectedVersion: meal.version });
  });
  fixture.save.mockImplementation(async (draft: MealDraft, mutationId: string, userId: string) => {
    const saved: MealRecord = { ...draft, mutationId, userId, updatedAt: new Date().toISOString() };
    state.jobs.push({ id: mutationId, kind: "save", record: saved, expectedVersion: draft.version });
    return saved;
  });
  localStorage.clear(); history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network allowed in notice tests"); }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("clears a delete's pending notice only after the durable acknowledgement snapshot has no jobs", async () => {
  state.remote = [record()];
  await start(); await removeMeal();
  Object.defineProperty(navigator, "onLine", { value: true });
  const acknowledged = deferred<SyncState>();
  fixture.state.mockImplementationOnce(() => acknowledged.promise);
  await refresh();
  expect(fixture.sync).toHaveBeenCalledOnce();
  // Resolving sync alone is not evidence that every durable job was acknowledged.
  expect(screen.getByText(localAcknowledgement)).toBeVisible();
  state = { ...emptyState(), syncedAt: new Date().toISOString() };
  await act(async () => { acknowledged.resolve(state); });
  await waitFor(() => expect(document.querySelector(".journal-notice")).not.toBeInTheDocument());
  expect(screen.queryByText(/項修改待同步/)).not.toBeInTheDocument();
});

it.each([undefined, "conflict"])("keeps the local notice when durable jobs remain, including error %s", async error => {
  state.remote = [record()];
  await start(); await removeMeal();
  state.jobs[0].error = error;
  state.syncedAt = new Date().toISOString();
  Object.defineProperty(navigator, "onLine", { value: true });
  await refresh();
  expect(fixture.sync).toHaveBeenCalledOnce();
  expect(screen.getByText(pendingNotice(1))).toBeVisible();
  expect(screen.getByText(/1 項修改待同步/)).toBeVisible();
});

it("preserves an unrelated local storage error after a current empty durable snapshot", async () => {
  fixture.snapshot.mockRejectedValueOnce(new Error("Storage full"));
  await start();
  await screen.findByText(storageNotice);
  state = { ...emptyState(), syncedAt: new Date().toISOString() };
  await refresh();
  expect(screen.getByText(storageNotice)).toBeVisible();
});

it("does not claim an acknowledged delete is pending when another meal has a blocked save", async () => {
  state.remote = [record("已刪除餐點")];
  await start(); await removeMeal();
  const otherMeal = record("另一筆待處理餐點");
  state = {
    remote: [], syncedAt: new Date().toISOString(),
    jobs: [{ id: otherMeal.mutationId, kind: "save", record: otherMeal, expectedVersion: 1, error: "conflict" }],
  };
  await refresh();
  expect(screen.queryByText(deleteNotice)).not.toBeInTheDocument();
  expect(screen.getByText(pendingNotice(1))).toBeVisible();
  expect(screen.getByRole("heading", { name: "另一筆待處理餐點" })).toBeVisible();
  expect(screen.getByRole("button", { name: "保留修改為新餐點草稿" })).toBeVisible();
});

it("preserves an operation error when no pending jobs exist", async () => {
  state.remote = [record()];
  fixture.remove.mockRejectedValueOnce(new Error("Local delete failed"));
  await start();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刪除" })); });
  const message = "未能完成操作，請檢查網絡後再試。已保留的修改不會被清除。";
  await screen.findByText(message);
  await refresh();
  expect(screen.getByText(message)).toBeVisible();
});

it("clears a saved meal's local acknowledgement after its durable job is gone", async () => {
  cache.draft = { ...newDraft(), items: createEditableFoodItems(demoFoodAnalysis.foods) };
  await start();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "繼續草稿" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "離線儲存餐點" })); });
  await screen.findByText(localAcknowledgement);
  await screen.findByText(/1 項修改待同步/);
  state = { remote: [state.jobs[0].record], jobs: [], syncedAt: null };
  await refresh();
  await waitFor(() => expect(document.querySelector(".journal-notice")).not.toBeInTheDocument());
  expect(fixture.save).toHaveBeenCalledOnce();
});

it("keeps clear-all acknowledgement until every delete job is gone", async () => {
  state.remote = [record("第一餐"), record("第二餐")];
  await start();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "帳戶與安裝" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "清除全部記錄" })); });
  await screen.findByText(localAcknowledgement);
  await screen.findByText(/2 項修改待同步/);
  expect(fixture.remove).toHaveBeenCalledTimes(2);
  state = { ...state, remote: [], jobs: state.jobs.slice(1), syncedAt: new Date().toISOString() };
  await refresh();
  expect(screen.getByText(localAcknowledgement)).toBeVisible();
  expect(screen.getByText(/1 項修改待同步/)).toBeVisible();
  state = emptyState();
  await refresh();
  await waitFor(() => expect(document.querySelector(".journal-notice")).not.toBeInTheDocument());
});

it("does not let a stale empty snapshot clear a newer pending delete notice", async () => {
  state.remote = [record()];
  const original = structuredClone(state);
  const oldRead = deferred<SyncState>(), newRead = deferred<SyncState>();
  fixture.state.mockResolvedValueOnce(original).mockImplementationOnce(() => oldRead.promise).mockImplementationOnce(() => newRead.promise);
  await start();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刪除" })); });
  await screen.findByText(deleteNotice);
  await act(async () => { oldRead.resolve(original); });
  await waitFor(() => expect(fixture.state).toHaveBeenCalledTimes(3));
  expect(screen.getByText(deleteNotice)).toBeVisible();
  await act(async () => { newRead.resolve(structuredClone(state)); });
  expect(screen.getByText(pendingNotice(1))).toBeVisible();
  expect(screen.getByText(/1 項修改待同步/)).toBeVisible();
});

it("does not let A's delayed empty snapshot clear B's newer local acknowledgement", async () => {
  state.remote = [record("A 的餐點")];
  await start();
  const oldA = deferred<SyncState>(), currentB = deferred<SyncState>();
  const bMeal = { ...record("B 的餐點"), userId: "notice-b" };
  const bState: SyncState = { remote: [bMeal], jobs: [], syncedAt: null };
  let bReads = 0;
  fixture.state.mockImplementation((uid: string) => {
    if (uid === "notice-user") return oldA.promise;
    return ++bReads === 1 ? Promise.resolve(structuredClone(bState)) : currentB.promise;
  });
  fixture.list.mockImplementation(async (uid: string) => visibleMeals(uid === "notice-b" ? bState : state));
  fixture.read.mockResolvedValue({ records: [], draft: null, syncedAt: null });
  fixture.remove.mockImplementation(async (meal: MealRecord) => {
    bState.jobs.push({ id: crypto.randomUUID(), kind: "delete", record: meal, expectedVersion: meal.version });
  });
  await refresh();
  await act(async () => { fixture.callback!({ uid: "notice-b", email: "b@example.com" }); });
  await screen.findByRole("heading", { name: "B 的餐點" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刪除" })); });
  await screen.findByText(deleteNotice);
  expect(bState.jobs).toHaveLength(1);
  await act(async () => { oldA.resolve(emptyState()); });
  await waitFor(() => expect(bReads).toBe(2));
  // B's current read is still pending; the empty A snapshot cannot clear its notice.
  expect(screen.getByText(deleteNotice)).toBeVisible();
  await act(async () => { currentB.resolve(structuredClone(bState)); });
  expect(screen.getByText(pendingNotice(1))).toBeVisible();
  expect(screen.getByText(/1 項修改待同步/)).toBeVisible();
  expect(screen.queryByRole("heading", { name: "A 的餐點" })).not.toBeInTheDocument();
});

it("keeps a dismissed local acknowledgement closed when pending state refreshes", async () => {
  state.remote = [record()];
  await start(); await removeMeal();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "關閉訊息" })); });
  expect(document.querySelector(".journal-notice")).not.toBeInTheDocument();
  await refresh();
  expect(document.querySelector(".journal-notice")).not.toBeInTheDocument();
  expect(screen.getByText(/1 項修改待同步/)).toBeVisible();
});
