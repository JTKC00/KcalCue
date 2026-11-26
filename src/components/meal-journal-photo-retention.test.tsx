// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { newDraft, type MealRecord } from "@/lib/meals/types";

const fixture = vi.hoisted(() => ({
  callback: null as null | ((user: { uid: string; email: string }) => void),
  list: vi.fn(),
  state: vi.fn(),
  save: vi.fn(),
  saveWithPhoto: vi.fn(),
  saveQueuedWithoutPhoto: vi.fn(),
  sync: vi.fn(),
  write: vi.fn(),
  preparePhoto: vi.fn(),
  uid: "a",
}));

vi.mock("@/lib/firebase/client", () => ({
  cloudConfigured: () => true,
  hasEmailLink: () => false,
  signOut: vi.fn(),
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
    save = fixture.save;
    saveWithPhoto = fixture.saveWithPhoto;
    saveQueuedWithoutPhoto = fixture.saveQueuedWithoutPhoto;
    sync = fixture.sync;
  },
}));
vi.mock("@/lib/meals/cache", () => ({
  draftTabId: () => "test-tab",
  prepareDraftTabId: async () => "test-tab",
  localMeals: {
    read: async () => ({ records: [], draft: null, syncedAt: null }),
    write: fixture.write,
    writeSnapshot: async () => {},
    clear: async () => {},
    listDrafts: async () => [],
    restoreDraft: vi.fn(),
  },
}));
vi.mock("@/lib/meals/photo", async (original) => ({
  ...(await original<typeof import("@/lib/meals/photo")>()),
  preparePhoto: fixture.preparePhoto,
}));
vi.mock("./kcalcue-app", () => ({
  KcalCueApp: ({ onPhotoSelected, onDraftChange }: {
    onPhotoSelected: (file: File) => void;
    onDraftChange: (change: { mode: "live"; analysis: typeof demoFoodAnalysis; items: ReturnType<typeof createEditableFoodItems> }) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          onDraftChange({
            mode: "live",
            analysis: demoFoodAnalysis,
            items: createEditableFoodItems(demoFoodAnalysis.foods),
          });
          onPhotoSelected(new File(["photo"], "meal.jpg", { type: "image/jpeg" }));
        }}
      >
        模擬AI起草並選圖
      </button>
    </div>
  ),
}));
vi.mock("./pwa-controls", () => ({ PwaControls: () => null }));
vi.mock("./firebase-account", () => ({ Account: () => null }));

import { MealJournal } from "./meal-journal";

beforeEach(() => {
  fixture.list.mockReset().mockResolvedValue([]);
  fixture.state.mockReset().mockResolvedValue({ remote: [], jobs: [], syncedAt: null });
  fixture.save.mockReset().mockImplementation(async (draft, mutationId) => ({
    ...draft, userId: "a", mutationId, version: draft.version + 1, updatedAt: new Date().toISOString(),
  }));
  fixture.saveWithPhoto.mockReset().mockImplementation(async (draft, mutationId) => ({
    ...draft, userId: "a", mutationId, version: draft.version + 1, updatedAt: new Date().toISOString(),
  }));
  fixture.saveQueuedWithoutPhoto.mockReset().mockResolvedValue(crypto.randomUUID());
  fixture.sync.mockReset();
  fixture.write.mockReset();
  fixture.preparePhoto.mockReset().mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
  fixture.uid = "a";
  localStorage.clear();
  window.history.replaceState(null, "", "#today");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
});

afterEach(cleanup);

it("hides photo retention opt-in and preserves non-saving privacy copy when disabled", async () => {
  render(<MealJournal initialProviderMode="live" initialPhotoUploadsEnabled={false} />);
  await act(async () => { fixture.callback?.({ uid: "a", email: "a@example.com" }); });

  fireEvent.click(screen.getByRole("button", { name: "帳戶與安裝" }));
  expect(screen.getByText(/不會存入 Firebase Storage/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "新增" }));
  fireEvent.click(screen.getByRole("button", { name: "模擬AI起草並選圖" }));
  await waitFor(() => expect(fixture.preparePhoto).toHaveBeenCalled());
  expect(screen.queryByRole("checkbox", { name: /儲存餐點縮圖供歷史查看/ })).not.toBeInTheDocument();
});

it("defaults opt-in unchecked, queues photo atomically when checked offline, and supports remove + escape hatch", async () => {
  const blockedJob = {
    id: crypto.randomUUID(),
    kind: "save" as const,
    expectedVersion: 0,
    error: "photo_output_too_large",
    photoUpload: {
      uploadId: crypto.randomUUID(),
      sha256: "a".repeat(64),
      byteSize: 100,
      pipelineVersion: 1,
      status: "pending" as const,
    },
    record: {
      ...newDraft(),
      userId: "a",
      version: 1,
      mutationId: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
      items: createEditableFoodItems(demoFoodAnalysis.foods),
    } satisfies MealRecord,
  };
  fixture.state.mockResolvedValue({ remote: [], jobs: [blockedJob], syncedAt: null });

  render(<MealJournal initialProviderMode="live" initialPhotoUploadsEnabled={true} />);
  await act(async () => { fixture.callback?.({ uid: "a", email: "a@example.com" }); });

  // Blocked photo upload job offers escape hatch without photo.
  fireEvent.click(await screen.findByRole("button", { name: "不附圖儲存餐點" }));
  await waitFor(() => expect(fixture.saveQueuedWithoutPhoto).toHaveBeenCalledWith(blockedJob.record.id, blockedJob.id, "a"));

  // Privacy copy reflects optional thumbnail retention when enabled.
  fireEvent.click(screen.getByRole("button", { name: "帳戶與安裝" }));
  expect(screen.getByText(/只有在你明確勾選「儲存餐點縮圖供歷史查看」並儲存後/)).toBeInTheDocument();

  // Opt-in starts unchecked, and checking it saves via saveWithPhoto + local pending message offline.
  fireEvent.click(screen.getByRole("button", { name: "新增" }));
  fireEvent.click(screen.getByRole("button", { name: "模擬AI起草並選圖" }));
  const checkbox = await screen.findByRole("checkbox", { name: /儲存餐點縮圖供歷史查看/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();

  fixture.saveWithPhoto.mockImplementationOnce(async (draft, mutationId, uploadId) => {
    const record = {
      ...draft, userId: "a", mutationId, version: draft.version + 1, updatedAt: new Date().toISOString(),
    };
    fixture.state.mockResolvedValue({
      remote: [],
      jobs: [{
        id: mutationId,
        kind: "save",
        expectedVersion: draft.version,
        photoUpload: {
          uploadId,
          sha256: "a".repeat(64),
          byteSize: 4,
          pipelineVersion: 1,
          status: "pending",
        },
        record,
      }],
      syncedAt: null,
    });
    return record;
  });

  fireEvent.click(screen.getByRole("button", { name: /離線儲存餐點/ }));
  await waitFor(() => expect(fixture.saveWithPhoto).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("已保留本機；餐點及附圖待同步。")).toBeInTheDocument();
});
