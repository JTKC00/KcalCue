// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { newDraft, type MealRecord } from "@/lib/meals/types";
const fixture = vi.hoisted(() => ({
  callback: null as null | ((user: { uid: string; email: string }) => void),
  list: vi.fn(),
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
    state = async (uid: string) => ({ remote: await fixture.list(uid), jobs: [], syncedAt: null });
    sync = async () => {};
  },
}));
vi.mock("@/lib/meals/cache", () => ({
  localMeals: {
    read: async () => ({ records: [], draft: null, syncedAt: null }),
    write: async () => {},
    clear: async () => {},
  },
}));
vi.mock("./kcalcue-app", () => ({ KcalCueApp: () => null }));
vi.mock("./pwa-controls", () => ({ PwaControls: () => null }));
vi.mock("./firebase-account", () => ({ Account: () => null }));
import { MealJournal } from "./meal-journal";
beforeEach(() => {
  fixture.list.mockReset();
  localStorage.clear();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: false,
  });
});
afterEach(cleanup);
it("shows an explicit zero-meal and zero-kcal Today summary", async () => {
  fixture.list.mockResolvedValue([]);
  render(<MealJournal initialProviderMode="demo" />);
  await act(async () => {
    fixture.callback!({ uid: "a", email: "a@example.com" });
  });
  const summary = await screen.findByLabelText("今日摘要");
  expect(summary).toHaveTextContent("今日餐數0餐");
  expect(summary).toHaveTextContent("卡路里0kcal");
});

it("labels an insufficient meal unknown and excludes its partial kcal from Today", async () => {
  const known = createEditableFoodItems([demoFoodAnalysis.foods[0]])[0];
  const match = new LocalNutritionProvider().resolve(known);
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
