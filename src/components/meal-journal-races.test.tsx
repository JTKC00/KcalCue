// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { newDraft, type MealDraft, type MealRecord } from "@/lib/meals/types";
import { visibleMeals, type SyncState } from "@/lib/meals/outbox";
import type { LocalMeals } from "@/lib/meals/cache";
import { provenance } from "@/test/provenance-fixture";

const fixture = vi.hoisted(() => ({
  callback: null as null | ((user: { uid: string; email: string }) => void),
  uid: "a",
  list: vi.fn(),
  state: vi.fn(),
  sync: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  discard: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  clearSync: vi.fn(),
  signOut: vi.fn(),
  photoFetch: vi.fn(),
  draftChange: null as null | ((change: Pick<MealDraft, "items" | "analysis" | "analysisProvenance" | "mode">) => void),
}));
vi.mock("@/lib/firebase/client", () => ({
  cloudConfigured: () => true,
  hasEmailLink: () => false,
  signOut: fixture.signOut,
  authorizedFetch: fixture.photoFetch,
  firebaseAuth: () => ({ currentUser: { uid: fixture.uid } }),
  onAuthStateChanged: (_auth: unknown, callback: typeof fixture.callback) => {
    fixture.callback = callback;
    return () => {};
  },
}));
vi.mock("@/lib/meals/repository", () => ({
  RepositoryError: class extends Error {
    constructor(public code: string, public status: number) { super(code); }
  },
  MealRepository: class {
    list = fixture.list;
    state = fixture.state;
    sync = fixture.sync;
    save = fixture.save;
    delete = fixture.remove;
    discardPending = fixture.discard;
  },
}));
vi.mock("@/lib/meals/outbox", async (original) => ({
  ...(await original<typeof import("@/lib/meals/outbox")>()),
  clearSyncState: fixture.clearSync,
}));
vi.mock("@/lib/meals/cache", () => ({
  localMeals: { read: fixture.read, write: fixture.write, clear: fixture.clear },
}));
vi.mock("./kcalcue-app", () => ({
  KcalCueApp: ({ initialDraft, onDraftChange }: { initialDraft: MealDraft; onDraftChange: NonNullable<typeof fixture.draftChange> }) => {
    fixture.draftChange = onDraftChange;
    return (
    <div data-testid="editor-meal" data-created-at={initialDraft.createdAt ?? "unknown"}>
      {initialDraft.items[0]?.displayName}
    </div>
    );
  },
}));
vi.mock("./pwa-controls", () => ({ PwaControls: () => null }));
vi.mock("./firebase-account", () => ({ Account: () => null }));
import { MealJournal } from "./meal-journal";
import { RepositoryError } from "@/lib/meals/repository";

const states = new Map<string, SyncState>();
const caches = new Map<string, LocalMeals>();
const emptySync = (): SyncState => ({ remote: [], jobs: [], syncedAt: null });
const emptyCache = (): LocalMeals => ({ records: [], draft: null, syncedAt: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
function record(uid: string, name = `meal-${uid}`): MealRecord {
  return {
    ...newDraft(), userId: uid, version: 1,
    mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString(),
    items: [{ ...createEditableFoodItems(demoFoodAnalysis.foods)[0], displayName: name }],
  };
}
async function signIn(uid: string) {
  fixture.uid = uid;
  await act(async () => { fixture.callback!({ uid, email: `${uid}@example.com` }); });
}
function conflict(meal: MealRecord) {
  states.set(meal.userId, {
    remote: [], syncedAt: null,
    jobs: [{ id: meal.mutationId, kind: "save", record: meal, expectedVersion: 0, error: "conflict" }],
  });
}
async function startConflictRecovery(meal: MealRecord) {
  conflict(meal);
  render(<MealJournal initialProviderMode="live" />);
  await signIn(meal.userId);
  const button = await screen.findByRole("button", { name: "保留修改為新餐點草稿" });
  await waitFor(() => expect(button).toBeEnabled());
  const write = deferred<void>();
  fixture.write.mockImplementationOnce(async (uid: string, value: LocalMeals) => {
    await write.promise;
    caches.set(uid, structuredClone(value));
  });
  await act(async () => { fireEvent.click(button); });
  await waitFor(() => expect(fixture.write.mock.calls.some(([, value]) => value.draft?.items[0]?.displayName === meal.items[0].displayName)).toBe(true));
  return write;
}

beforeEach(() => {
  states.clear(); caches.clear(); fixture.uid = "a";
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const mock of [fixture.list, fixture.state, fixture.sync, fixture.save, fixture.remove, fixture.discard, fixture.read, fixture.write, fixture.clear, fixture.clearSync, fixture.signOut, fixture.photoFetch]) mock.mockReset();
  fixture.list.mockImplementation(async (uid: string) => visibleMeals(structuredClone(states.get(uid) ?? emptySync())));
  fixture.state.mockImplementation(async (uid: string) => structuredClone(states.get(uid) ?? emptySync()));
  fixture.sync.mockResolvedValue(undefined);
  fixture.read.mockImplementation(async (uid: string) => structuredClone(caches.get(uid) ?? emptyCache()));
  fixture.write.mockImplementation(async (uid: string, value: LocalMeals) => { caches.set(uid, structuredClone(value)); });
  fixture.clear.mockImplementation(async (uid: string) => { caches.delete(uid); });
  fixture.discard.mockResolvedValue(undefined);
  fixture.clearSync.mockResolvedValue(undefined);
  fixture.signOut.mockResolvedValue(undefined);
  localStorage.clear(); history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reads a private photo only in History and removes its URL on account change", async () => {
  const meal = {
    ...record("a", "photo-meal"),
    photoRef: {
      attachmentId: "461fe664-d9c7-4fc2-8ea3-c641954838c6",
      generation: "1837167347458867",
      contentType: "image/jpeg" as const,
      width: 640, height: 480, byteSize: 3,
    },
  };
  states.set("a", { ...emptySync(), remote: [meal] });
  const createUrl = vi.fn().mockReturnValue("blob:account-a-photo");
  const revokeUrl = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl });
  fixture.photoFetch.mockResolvedValue(new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), {
    headers: { "Content-Type": "image/jpeg" },
  }));
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await screen.findByRole("heading", { name: "photo-meal" });
  expect(fixture.photoFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "歷史" }));
  expect(fixture.photoFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "查看餐點附圖" }));
  expect(await screen.findByRole("img", { name: "餐點附圖" })).toHaveAttribute("src", "blob:account-a-photo");
  await signIn("b");
  await screen.findByRole("heading", { name: "未有餐點記錄" });
  expect(revokeUrl).toHaveBeenCalledWith("blob:account-a-photo");
  expect(screen.queryByRole("img", { name: "餐點附圖" })).not.toBeInTheDocument();
});

it("never renders, caches, or discards an old account's conflict under the next account", async () => {
  const meal = record("a", "private-a");
  const write = await startConflictRecovery(meal);
  await signIn("b");
  await screen.findByRole("heading", { name: "今日未有記錄" });
  await act(async () => { write.resolve(); });
  await waitFor(() => expect(screen.getByRole("button", { name: "帳戶與安裝" })).toBeEnabled());
  expect(fixture.discard).not.toHaveBeenCalled();
  expect(screen.queryByTestId("editor-meal")).not.toBeInTheDocument();
  expect(fixture.write.mock.calls.some(([uid, value]) => uid === "b" && value.draft?.items[0]?.displayName === "private-a")).toBe(false);
  expect(states.get("a")?.jobs).toHaveLength(1);
});

it("rejects a conflict recovery continuation after A to B to A", async () => {
  const meal = record("a", "private-a");
  const write = await startConflictRecovery(meal);
  await signIn("b");
  await screen.findByRole("heading", { name: "今日未有記錄" });
  await signIn("a");
  await screen.findByRole("heading", { name: "private-a" });
  await act(async () => { write.resolve(); });
  await waitFor(() => expect(screen.getByRole("button", { name: "帳戶與安裝" })).toBeEnabled());
  expect(fixture.discard).not.toHaveBeenCalled();
  expect(screen.queryByTestId("editor-meal")).not.toBeInTheDocument();
  expect(states.get("a")?.jobs).toHaveLength(1);
});

it("ignores a delayed B account load when authentication has returned to A", async () => {
  const a = record("a"), b = record("b");
  states.set("a", { ...emptySync(), remote: [a] });
  states.set("b", { ...emptySync(), remote: [b] });
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await screen.findByRole("heading", { name: "meal-a" });
  const loadingB = deferred<LocalMeals>();
  fixture.read.mockImplementation(async (uid: string) => uid === "b" ? loadingB.promise : emptyCache());
  await signIn("b");
  await waitFor(() => expect(fixture.read).toHaveBeenCalledWith("b"));
  await signIn("a");
  await act(async () => { loadingB.resolve(emptyCache()); });
  await screen.findByRole("heading", { name: "meal-a" });
  expect(screen.queryByRole("heading", { name: "meal-b" })).not.toBeInTheDocument();
});

it("rejects a pre-delete refresh snapshot and follows up with the current snapshot", async () => {
  const meal = record("a");
  const original = { ...emptySync(), remote: [meal] };
  states.set("a", original);
  const oldRead = deferred<SyncState>(), newRead = deferred<SyncState>();
  fixture.state.mockResolvedValueOnce(original).mockImplementationOnce(() => oldRead.promise).mockImplementationOnce(() => newRead.promise);
  fixture.remove.mockImplementation(async () => {
    states.set("a", { ...original, jobs: [{ id: crypto.randomUUID(), kind: "delete", record: meal, expectedVersion: 1 }] });
  });
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await screen.findByRole("heading", { name: "meal-a" });
  await waitFor(() => expect(fixture.state).toHaveBeenCalledTimes(2));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刪除" })); });
  expect(screen.queryByRole("heading", { name: "meal-a" })).not.toBeInTheDocument();
  await act(async () => { oldRead.resolve(original); });
  await waitFor(() => expect(fixture.state).toHaveBeenCalledTimes(3));
  expect(screen.queryByRole("heading", { name: "meal-a" })).not.toBeInTheDocument();
  await act(async () => { newRead.resolve(states.get("a")!); });
  expect(screen.queryByRole("heading", { name: "meal-a" })).not.toBeInTheDocument();
  expect(screen.getByText(/1 項修改待同步/)).toBeVisible();
});

it("coalesces sync requests arriving during an active refresh into one follow-up", async () => {
  Object.defineProperty(navigator, "onLine", { value: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
  const first = deferred<void>();
  fixture.sync.mockImplementationOnce(() => first.promise).mockImplementation(async () => {
    states.set("a", { ...emptySync(), remote: [record("a", "new-cloud-meal")] });
  });
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await waitFor(() => expect(fixture.sync).toHaveBeenCalledTimes(1));
  await act(async () => {
    window.dispatchEvent(new Event("kcalcue-sync"));
    window.dispatchEvent(new Event("kcalcue-sync"));
  });
  await act(async () => { first.resolve(); });
  await screen.findByRole("heading", { name: "new-cloud-meal" });
  expect(fixture.sync).toHaveBeenCalledTimes(2);
});


it("does not clear or sign out B when A's logout preflight finishes after an account change", async () => {
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await screen.findByRole("heading", { name: "今日未有記錄" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "帳戶與安裝" })); });
  const preflight = deferred<SyncState>();
  fixture.state.mockImplementationOnce(() => preflight.promise);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "登出並清除本機資料" })); });
  await signIn("b");
  await screen.findByText("b@example.com");
  await act(async () => { preflight.resolve(emptySync()); });
  expect(fixture.clear).not.toHaveBeenCalled();
  expect(fixture.clearSync).not.toHaveBeenCalled();
  expect(fixture.signOut).not.toHaveBeenCalled();
  expect(screen.getByText("b@example.com")).toBeVisible();
  expect(localStorage.getItem("kcalcue-logout")).toBeNull();
});

it("clears an obsolete trial access error after a later successful sync", async () => {
  Object.defineProperty(navigator, "onLine", { value: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
  fixture.sync.mockRejectedValueOnce(new RepositoryError("trial_access_required", 403));
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await screen.findByText(/這個 Email 尚未獲得試用權限/);
  await act(async () => { window.dispatchEvent(new Event("kcalcue-sync")); });
  await waitFor(() => expect(fixture.sync).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/這個 Email 尚未獲得試用權限/)).not.toBeInTheDocument());
});

it("clears server metadata when preserving a conflicted edit as a new meal", async () => {
  const meal = { ...record("a"), mode: "live" as const, analysis: demoFoodAnalysis, analysisProvenance: provenance,
    schemaVersion: 1, createdAt: "2026-08-01T00:00:00.000Z" };
  const write = await startConflictRecovery(meal);
  const copy = fixture.write.mock.calls.find(([, value]) => value.draft?.items[0]?.displayName === meal.items[0].displayName)![1].draft;
  expect(copy.id).not.toBe(meal.id);
  expect(copy.version).toBe(0);
  expect(copy.createdAt).toBeUndefined();
  expect(copy.schemaVersion).toBeUndefined();
  expect(copy.pendingMutation).toBeUndefined();
  expect(copy.items).toEqual(meal.items);
  expect(copy.analysis).toEqual(meal.analysis);
  expect(copy.analysisProvenance).toEqual(provenance);
  expect(meal.createdAt).toBe("2026-08-01T00:00:00.000Z");
  await act(async () => { write.resolve(); });
  await screen.findByTestId("editor-meal");
  expect(screen.getByTestId("editor-meal")).toHaveAttribute("data-created-at", "unknown");
});

it("retains server creation metadata when opening an ordinary edit", async () => {
  const meal = { ...record("a"), schemaVersion: 1, createdAt: "2026-08-01T00:00:00.000Z" };
  states.set("a", { ...emptySync(), remote: [meal] });
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await screen.findByRole("heading", { name: "meal-a" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看／修正" })); });
  await screen.findByTestId("editor-meal");
  expect(screen.getByTestId("editor-meal")).toHaveAttribute("data-created-at", meal.createdAt);
});

it("reuses a saved retry identity when only server metadata was added to the restored draft", async () => {
  const meal = { ...record("a"), analysisProvenance: undefined };
  caches.set("a", { ...emptyCache(), draft: meal });
  fixture.save.mockRejectedValue(new Error("Local storage unavailable"));
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "繼續草稿" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "離線儲存餐點" })); });
  await waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(caches.get("a")?.draft?.pendingMutation).toBeDefined());
  const retained = structuredClone(caches.get("a")!);
  retained.draft = { ...retained.draft!, schemaVersion: 1, createdAt: "2026-08-01T00:00:00.000Z", analysisProvenance: null };
  cleanup();
  caches.set("a", retained);
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  // The failed save left #new selected, so reload restores the editor directly.
  await screen.findByTestId("editor-meal");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "離線儲存餐點" })); });
  await waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(2));
  expect(fixture.save.mock.calls[1][1]).toBe(fixture.save.mock.calls[0][1]);
  expect(fixture.save.mock.calls[1][0].createdAt).toBe("2026-08-01T00:00:00.000Z");
});

it("replaces an unsaved analysis baseline only when a new analysis arrives", async () => {
  const items = createEditableFoodItems(demoFoodAnalysis.foods);
  const draft = { ...newDraft(), mode: "live" as const, analysis: demoFoodAnalysis, analysisProvenance: provenance,
    items, originalItems: items, calorieCorrection: { kcal: 650, source: "user" as const }, calorieInput: "650" };
  caches.set("a", { ...emptyCache(), draft });
  render(<MealJournal initialProviderMode="live" />);
  await signIn("a");
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "繼續草稿" })); });
  await screen.findByTestId("editor-meal");
  // Metadata alone is not a food change and must not erase manual kcal input.
  const metadataOnly = { ...provenance, reportedModel: null };
  await act(async () => { fixture.draftChange!({ items, analysis: demoFoodAnalysis, analysisProvenance: metadataOnly, mode: "live" }); });
  await waitFor(() => expect(caches.get("a")?.draft?.analysisProvenance).toEqual(metadataOnly));
  expect(caches.get("a")?.draft?.calorieInput).toBe("650");
  expect(caches.get("a")?.draft?.calorieCorrection).toEqual(draft.calorieCorrection);

  const nextAnalysis = { ...demoFoodAnalysis, foods: [demoFoodAnalysis.foods[1]] };
  const nextItems = createEditableFoodItems(nextAnalysis.foods);
  const nextProvenance = { ...provenance, analyzedAt: "2026-09-26T12:00:00.000Z" };
  await act(async () => { fixture.draftChange!({ items: nextItems, analysis: nextAnalysis, analysisProvenance: nextProvenance, mode: "live" }); });
  await waitFor(() => expect(caches.get("a")?.draft?.analysisProvenance).toEqual(nextProvenance));
  expect(caches.get("a")?.draft?.originalItems).toEqual(nextItems);
  expect(caches.get("a")?.draft?.calorieCorrection).toBeNull();
  await act(async () => { fixture.draftChange!({ items: nextItems.map((item) => ({ ...item, portionMin: item.portionMin + 1 })),
    analysis: nextAnalysis, analysisProvenance: nextProvenance, mode: "live" }); });
  await waitFor(() => expect(caches.get("a")?.draft?.items[0].portionMin).toBe(nextItems[0].portionMin + 1));
  expect(caches.get("a")?.draft?.originalItems).toEqual(nextItems);
  expect(caches.get("a")?.draft?.analysisProvenance).toEqual(nextProvenance);
});
