// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
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
    state = async () => ({ jobs: [], syncedAt: null });
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
