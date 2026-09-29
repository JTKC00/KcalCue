// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { foodEstimateSchema } from "@/lib/domain/food-analysis";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { newDraft, type MealRecord } from "@/lib/meals/types";
const fixture = vi.hoisted(() => ({
  callback: null as null | ((user: { uid: string; email: string }) => void),
  list: vi.fn(),
  write: vi.fn(),
  preparePhoto: vi.fn(),
  sync: vi.fn(),
  syncedAt: {} as Record<string, string | null>,
  cachedSyncedAt: null as string | null,
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
  RepositoryError: class extends Error {},
  MealRepository: class {
    list = fixture.list;
    state = async (uid: string) => ({
      remote: await fixture.list(uid), jobs: [], syncedAt: fixture.syncedAt[uid] ?? null,
    });
    sync = fixture.sync;
  },
}));
vi.mock("@/lib/meals/cache", () => ({
  draftTabId: () => "test-tab",
  prepareDraftTabId: async () => "test-tab",
  localMeals: {
    read: async () => ({ records: [], draft: null, syncedAt: fixture.cachedSyncedAt }),
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
  KcalCueApp: ({ onPhotoSelected }: { onPhotoSelected: (file: File) => void }) => (
    <button type="button" onClick={() => onPhotoSelected(new File(["photo"], "meal.jpg"))}>
      選擇測試照片
    </button>
  ),
}));
vi.mock("./pwa-controls", () => ({ PwaControls: () => null }));
vi.mock("./firebase-account", () => ({ Account: () => null }));
import { MealJournal } from "./meal-journal";
import { PhotoPreparationError } from "@/lib/meals/photo";
beforeEach(() => {
  fixture.list.mockReset();
  fixture.write.mockReset();
  fixture.preparePhoto.mockReset();
  fixture.sync.mockReset();
  fixture.syncedAt = {};
  fixture.cachedSyncedAt = null;
  fixture.uid = "a";
  localStorage.clear();
  window.history.replaceState(null, "", "#today");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: false,
  });
});
afterEach(cleanup);
it("offers a lower-resolution image instead of futile retry after a pixel-limit rejection", async () => {
  fixture.list.mockResolvedValue([]);
  fixture.preparePhoto.mockRejectedValue(new PhotoPreparationError("image_dimensions_too_large"));
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "＋ 新增餐點" }));
  fireEvent.click(screen.getByRole("button", { name: "選擇測試照片" }));

  expect(await screen.findByText(/圖片像素超過 4000 萬/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "重試照片處理" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移除草稿圖片" })).toBeVisible();
});

it("still offers retry for a transient photo preparation failure", async () => {
  fixture.list.mockResolvedValue([]);
  fixture.preparePhoto.mockRejectedValue(new PhotoPreparationError("photo_failed"));
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "＋ 新增餐點" }));
  fireEvent.click(screen.getByRole("button", { name: "選擇測試照片" }));

  expect(await screen.findByText(/照片壓縮未完成/)).toBeVisible();
  expect(screen.getByRole("button", { name: "重試照片處理" })).toBeVisible();
});

it("shows a delayed retry when photo preparation is rate limited", async () => {
  fixture.list.mockResolvedValue([]);
  fixture.preparePhoto.mockRejectedValue(new PhotoPreparationError("photo_rate_limited"));
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "＋ 新增餐點" }));
  fireEvent.click(screen.getByRole("button", { name: "選擇測試照片" }));

  expect(await screen.findByText(/照片處理稍忙，請約 10 秒後重試/)).toBeVisible();
  expect(screen.getByRole("button", { name: "重試照片處理" })).toBeVisible();
});

it("does not retain the previous draft photo when a valid replacement fails preparation", async () => {
  fixture.list.mockResolvedValue([]);
  const previous = new Blob(["previous photo"], { type: "image/jpeg" });
  fixture.preparePhoto.mockResolvedValueOnce(previous)
    .mockRejectedValueOnce(new PhotoPreparationError("photo_failed"));
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "＋ 新增餐點" }));
  fireEvent.click(screen.getByRole("button", { name: "選擇測試照片" }));
  await waitFor(() => expect(fixture.write.mock.calls.some(([, state]) =>
    state.draft?.photo === previous,
  )).toBe(true));

  fireEvent.click(screen.getByRole("button", { name: "選擇測試照片" }));
  expect(await screen.findByText(/照片壓縮未完成/)).toBeVisible();
  await waitFor(() => expect(fixture.write.mock.lastCall?.[1]?.draft?.photo).toBeUndefined());
});
it("clears the pixel-limit notice after selecting a smaller photo", async () => {
  fixture.list.mockResolvedValue([]);
  fixture.preparePhoto
    .mockRejectedValueOnce(new PhotoPreparationError("image_dimensions_too_large"))
    .mockResolvedValueOnce(new Blob(["compressed"], { type: "image/jpeg" }));
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "＋ 新增餐點" }));
  fireEvent.click(screen.getByRole("button", { name: "選擇測試照片" }));
  expect(await screen.findByText(/圖片像素超過 4000 萬/)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "選擇測試照片" }));
  await waitFor(() => expect(fixture.preparePhoto).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/圖片像素超過 4000 萬/)).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "重試照片處理" })).not.toBeInTheDocument();
});
it("keeps the saved AI recognition separate from corrected History values", async () => {
  const original = createEditableFoodItems([demoFoodAnalysis.foods[0]])[0];
  const corrected: MealRecord = {
    ...newDraft(), userId: "a", mode: "live",
    analysis: { ...demoFoodAnalysis, foods: [demoFoodAnalysis.foods[0]] },
    originalItems: [original],
    items: [{ ...original, displayName: "自訂魚飯", portionMin: 250, portionMax: 300 }],
    calorieCorrection: { kcal: 500, source: "user" },
    updatedAt: new Date().toISOString(), mutationId: crypto.randomUUID(),
  };
  // Older records can retain analysis without the later originalItems snapshot.
  delete (corrected as Partial<MealRecord>).originalItems;
  fixture.list.mockResolvedValue([corrected]);
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "歷史" }));

  const meal = screen.getByRole("article");
  expect(within(meal).getByRole("heading", { name: "自訂魚飯" })).toBeVisible();
  expect(meal).toHaveTextContent("目前記錄");
  expect(meal).toHaveTextContent("手動記錄：500 kcal");
  const originalDetails = within(meal).getByText("查看原始 AI 辨識").closest("details");
  expect(originalDetails).not.toBeNull();
  fireEvent.click(within(meal).getByText("查看原始 AI 辨識"));
  expect(originalDetails).toHaveAttribute("open");
  expect(originalDetails).toHaveTextContent("白飯：約 150–200 克 (g)");
  expect(originalDetails).toHaveTextContent("當時未能確認");
  expect(originalDetails).not.toHaveTextContent("500 kcal");
  expect(originalDetails).not.toHaveTextContent("自訂魚飯");
});

it("does not present manual food or missing legacy analysis as AI output", async () => {
  const item = createEditableFoodItems([demoFoodAnalysis.foods[0]])[0];
  const record = (mode: MealRecord["mode"], name: string): MealRecord => ({
    ...newDraft(), id: crypto.randomUUID(), userId: "a", mode,
    analysis: null, originalItems: [], items: [{ ...item, displayName: name }],
    updatedAt: new Date().toISOString(), mutationId: crypto.randomUUID(),
  });
  const legacy = record("live", "舊餐點");
  delete (legacy as Partial<MealRecord>).analysis;
  delete (legacy as Partial<MealRecord>).originalItems;
  const malformed = record("live", "異常舊餐點");
  malformed.analysis = {} as MealRecord["analysis"];
  fixture.list.mockResolvedValue([record("manual", "手動早餐"), legacy, malformed]);
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "歷史" }));

  const manual = screen.getByRole("heading", { name: "手動早餐" }).closest("article");
  const legacyArticle = screen.getByRole("heading", { name: "舊餐點" }).closest("article");
  const malformedArticle = screen.getByRole("heading", { name: "異常舊餐點" }).closest("article");
  expect(manual).not.toBeNull();
  expect(legacyArticle).not.toBeNull();
  expect(malformedArticle).not.toBeNull();
  expect(within(manual!).queryByText(/AI 辨識/)).not.toBeInTheDocument();
  fireEvent.click(within(legacyArticle!).getByText("原始 AI 辨識未保存"));
  expect(legacyArticle).toHaveTextContent("這筆舊紀錄沒有可核實的原始 AI 分析");
  fireEvent.click(within(malformedArticle!).getByText("原始 AI 辨識未保存"));
  expect(malformedArticle).toHaveTextContent("這筆舊紀錄沒有可核實的原始 AI 分析");
  expect(malformedArticle).not.toHaveTextContent("undefined");
});
it("shows an explicit zero-meal and zero-kcal Today summary", async () => {
  fixture.list.mockResolvedValue([]);
  fixture.syncedAt.a = "2026-09-27T12:00:00.000Z";
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => {
    fixture.callback!({ uid: "a", email: "a@example.com" });
  });
  const summary = await screen.findByLabelText("今日摘要");
  expect(summary).toHaveTextContent("今日餐數0餐");
  expect(summary).toHaveTextContent("卡路里0kcal");
});

it("does not present an unverified first cloud load as zero meals or empty history", async () => {
  fixture.list.mockResolvedValue([]);
  fixture.cachedSyncedAt = "2026-09-26T12:00:00.000Z";
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  expect(await screen.findByRole("heading", { name: "尚未確認今日記錄" })).toBeVisible();
  expect(screen.queryByLabelText("今日摘要")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "歷史" }));
  expect(screen.getByRole("heading", { name: "尚未確認歷史記錄" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "未有餐點記錄" })).not.toBeInTheDocument();
});

it("keeps the cloud list unverified after a failed first request, then shows zero after a successful empty read", async () => {
  fixture.list.mockResolvedValue([]);
  Object.defineProperty(navigator, "onLine", { value: true });
  fixture.sync.mockRejectedValueOnce(new TypeError("network failed"));
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  expect(await screen.findByRole("heading", { name: "尚未確認今日記錄" })).toBeVisible();
  expect(screen.queryByLabelText("今日摘要")).not.toBeInTheDocument();
  fixture.sync.mockImplementation(async (uid: string) => {
    fixture.syncedAt[uid] = "2026-09-27T12:00:00.000Z";
  });
  act(() => window.dispatchEvent(new Event("kcalcue-sync")));
  await waitFor(() => expect(screen.getByLabelText("今日摘要"))
    .toHaveTextContent("今日餐數0餐"));
  expect(screen.queryByRole("heading", { name: "尚未確認今日記錄" }))
    .not.toBeInTheDocument();
});

it("does not reuse a previous account's confirmed empty state after switching accounts", async () => {
  fixture.list.mockResolvedValue([]);
  fixture.syncedAt.a = "2026-09-27T12:00:00.000Z";
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  expect(await screen.findByLabelText("今日摘要")).toHaveTextContent("今日餐數0餐");
  fixture.uid = "b";
  await act(async () => fixture.callback!({ uid: "b", email: "b@example.com" }));
  expect(await screen.findByRole("heading", { name: "尚未確認今日記錄" })).toBeVisible();
  expect(screen.queryByLabelText("今日摘要")).not.toBeInTheDocument();
});

it("keeps local meals visible while making the missing cloud snapshot explicit", async () => {
  const item = createEditableFoodItems([demoFoodAnalysis.foods[0]])[0];
  fixture.list.mockResolvedValue([{
    ...newDraft(), userId: "a", mode: "manual",
    items: [{ ...item, displayName: "本機早餐" }],
    calorieCorrection: { kcal: 400, source: "user" },
    updatedAt: new Date().toISOString(), mutationId: crypto.randomUUID(),
  } satisfies MealRecord]);
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  expect(await screen.findByRole("heading", { name: "本機早餐" })).toBeVisible();
  expect(screen.getByText("雲端記錄尚未確認；以下只顯示本機已知餐點。"))
    .toBeVisible();
  expect(screen.getByLabelText("今日摘要")).toHaveTextContent("今日餐數1餐");
  expect(screen.queryByRole("heading", { name: "尚未確認今日記錄" }))
    .not.toBeInTheDocument();
});

it("keeps Today meal count and kcal aligned as records change", async () => {
  fixture.syncedAt.a = "2026-09-27T12:00:00.000Z";
  const item = createEditableFoodItems([demoFoodAnalysis.foods[0]])[0];
  const record = (kcal: number): MealRecord => ({
    ...newDraft(), id: crypto.randomUUID(), userId: "a", mode: "manual",
    items: [item], calorieCorrection: { kcal, source: "user" },
    updatedAt: new Date().toISOString(), mutationId: crypto.randomUUID(),
  });
  const first = record(400), second = record(600);
  fixture.list.mockResolvedValue([first, second]);
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  const summary = await screen.findByLabelText("今日摘要");
  await waitFor(() => expect(summary).toHaveTextContent("今日餐數2餐"));
  expect(summary).toHaveTextContent("卡路里1000kcal");

  fixture.list.mockResolvedValue([first]);
  act(() => window.dispatchEvent(new Event("kcalcue-sync")));
  await waitFor(() => expect(summary).toHaveTextContent("今日餐數1餐"));
  expect(summary).toHaveTextContent("卡路里400kcal");

  fixture.list.mockResolvedValue([]);
  act(() => window.dispatchEvent(new Event("kcalcue-sync")));
  await waitFor(() => expect(screen.getByLabelText("今日摘要")).toHaveTextContent("今日餐數0餐"));
  expect(screen.getByLabelText("今日摘要")).toHaveTextContent("卡路里0kcal");
});

it("groups Today meals by breakfast, lunch, dinner and snack without changing the daily total", async () => {
  const item = createEditableFoodItems([demoFoodAnalysis.foods[0]])[0];
  const record = (mealType: MealRecord["mealType"], name: string, time: string, kcal: number): MealRecord => ({
    ...newDraft(), id: crypto.randomUUID(), userId: "a", mode: "manual", mealType, time,
    items: [{ ...item, displayName: name }], calorieCorrection: { kcal, source: "user" },
    updatedAt: new Date().toISOString(), mutationId: crypto.randomUUID(),
  });
  fixture.list.mockResolvedValue([
    record("dinner", "晚餐測試", "12:00", 600),
    record("breakfast", "早餐測試", "19:00", 400),
  ]);
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));

  const summary = await screen.findByLabelText("今日摘要");
  await waitFor(() => expect(summary).toHaveTextContent("今日餐數2餐"));
  expect(summary).toHaveTextContent("卡路里1000kcal");
  const groups = ["早餐", "午餐", "晚餐", "小食"].map((name) => screen.getByRole("region", { name }));
  expect(groups[0].compareDocumentPosition(groups[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(groups[1].compareDocumentPosition(groups[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(groups[2].compareDocumentPosition(groups[3]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(groups[0]).getByRole("heading", { name: "早餐測試" })).toBeVisible();
  expect(within(groups[2]).getByRole("heading", { name: "晚餐測試" })).toBeVisible();
  expect(within(groups[1]).getByText("未有記錄")).toBeVisible();
  expect(within(groups[3]).getByText("未有記錄")).toBeVisible();
});

it("labels an insufficient meal unknown and excludes its partial kcal from Today", async () => {
  const known = createEditableFoodItems([demoFoodAnalysis.foods[0]])[0];
  const match = new LocalNutritionProvider().resolve(foodEstimateSchema.parse(known));
  const unknown = {
    ...known, id: "unresolved", displayName: "未知食物", normalizedName: "unknown food",
    nutritionMatch: { ...match, profile: null, includedInTotal: false },
  };
  const incomplete: MealRecord = {
    ...newDraft(), userId: "a", mode: "manual", items: [known, unknown],
    updatedAt: new Date().toISOString(), mutationId: crypto.randomUUID(),
  };
  fixture.list.mockResolvedValue([incomplete]);
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => {
    fixture.callback!({ uid: "a", email: "a@example.com" });
  });
  expect(await screen.findByText("整餐卡路里未知；詳情可查看已知食物估算")).toBeInTheDocument();
  const summary = document.querySelector(".day-summary");
  expect(summary).toHaveTextContent("卡路里未知kcal");
  expect(summary).toHaveTextContent("以上並非全日總數：1 餐未完整計入");
});

it("never renders an older account's late cache result after switching users", async () => {
  const record = (uid: string): MealRecord => ({
    ...newDraft(),
    userId: uid,
    updatedAt: new Date().toISOString(),
    mutationId: crypto.randomUUID(),
    items: [
      {
        ...createEditableFoodItems(demoFoodAnalysis.foods)[0],
        displayName: `meal-${uid}`,
      },
    ],
  });
  let finishA!: (value: MealRecord[]) => void;
  const delayed = new Promise<MealRecord[]>((resolve) => {
    finishA = resolve;
  });
  fixture.list.mockImplementation((uid: string) =>
    uid === "a" ? delayed : Promise.resolve([record("b")]),
  );
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => {
    fixture.callback!({ uid: "a", email: "a@example.com" });
  });
  await waitFor(() => expect(fixture.list).toHaveBeenCalledWith("a"));
  fixture.uid = "b";
  await act(async () => {
    fixture.callback!({ uid: "b", email: "b@example.com" });
  });
  await screen.findByRole("heading", { name: "meal-b" });
  await act(async () => {
    finishA([record("a")]);
  });
  expect(
    screen.queryByRole("heading", { name: "meal-a" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "meal-b" })).toBeVisible();
});

it("shows the corrected History meal and the original AI suggestion separately", async () => {
  const original = createEditableFoodItems([{
    ...demoFoodAnalysis.foods[1],
    displayName: "烤雞肉",
    normalizedName: "grilled chicken",
    portionMin: 280,
    portionMax: 420,
  }])[0];
  const corrected: MealRecord = {
    ...newDraft(), userId: "a", mode: "live",
    analysis: {
      ...demoFoodAnalysis,
      foods: [{ ...demoFoodAnalysis.foods[1], displayName: "烤雞肉", normalizedName: "grilled chicken", portionMin: 280, portionMax: 420 }],
    },
    originalItems: [original],
    items: [{ ...original, displayName: "三文魚", normalizedName: "三文魚", portionMin: 180, portionMax: 180 }],
    updatedAt: new Date().toISOString(), mutationId: crypto.randomUUID(),
  };
  fixture.list.mockResolvedValue([corrected]);
  render(<MealJournal initialProviderMode="live" />);
  await act(async () => fixture.callback!({ uid: "a", email: "a@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "歷史" }));
  const meal = screen.getByRole("article");
  expect(within(meal).getByRole("heading", { name: "三文魚" })).toBeVisible();
  expect(meal).not.toHaveTextContent("你食了");
  fireEvent.click(within(meal).getByText("查看原始 AI 辨識"));
  const details = within(meal).getByText("查看原始 AI 辨識").closest("details");
  expect(details).toHaveTextContent("烤雞肉：約 280–420 克 (g)");
  expect(details).not.toHaveTextContent("三文魚");
});
