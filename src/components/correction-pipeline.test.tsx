/** @vitest-environment jsdom */

import "../test/setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOOD_VISION_ANALYSIS_VERSION } from "@/lib/domain/analysis-provenance";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { NutritionService } from "@/lib/nutrition/service";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { KcalCueApp } from "./kcalcue-app";

const chickenAnalysis = {
  ...demoFoodAnalysis,
  foods: [{
    ...demoFoodAnalysis.foods[1],
    displayName: "烤雞肉",
    normalizedName: "grilled chicken",
    portionMin: 280,
    portionMax: 420,
    uncertaintyReasons: ["份量是估算。"],
  }],
  visibleEvidence: ["一塊烤過的肉。"],
  uncertaintyReasons: ["食物身份與份量都是 AI 估算。"],
};

const geminiProvenance = {
  provider: "gemini",
  requestedModel: "gemini-3.8-flash",
  reportedModel: "gemini-3.8-flash",
  modelVersion: null,
  analysisVersion: FOOD_VISION_ANALYSIS_VERSION,
  analyzedAt: "2026-09-29T02:00:00.000Z",
};

function pngFile() {
  return new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "meal.png", {
    type: "image/png",
  });
}

async function analyze(user: ReturnType<typeof userEvent.setup>, analysis = chickenAnalysis) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/analyze") {
      return Response.json({ mode: "live", analysis, analysisProvenance: geminiProvenance });
    }
    return Response.json({ matches: [] });
  }));
  const onDraftChange = vi.fn();
  render(<KcalCueApp initialProviderMode="live" onDraftChange={onDraftChange} />);
  await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]!, pngFile());
  await user.click(screen.getByRole("button", { name: /開始分析/ }));
  await waitFor(() => expect(onDraftChange).toHaveBeenCalled());
  return onDraftChange;
}

describe("user correction stays ahead of the original AI analysis", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:meal"),
      revokeObjectURL: vi.fn(),
    }));
  });

  it("replaces a wrong food identity and keeps the original suggestion", async () => {
    const user = userEvent.setup();
    const onDraftChange = await analyze(user);
    const name = screen.getByLabelText("食物名稱");
    await user.clear(name);
    await user.type(name, "三文魚");
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0].items[0].displayName).toBe("三文魚"));
    const draft = onDraftChange.mock.lastCall?.[0];
    if (!draft) throw new Error("missing draft");
    expect(draft.items[0].nutritionMatch.profile.canonicalName).toBe("salmon");
    expect(draft.items[0].nutritionMatch.profile.id).not.toBe(
      onDraftChange.mock.calls.find((call) => call[0].items[0].displayName === "烤雞肉")?.[0]
        .items[0].nutritionMatch.profile.id,
    );
    expect(draft.analysis.foods[0].displayName).toBe("烤雞肉");
    expect(draft.analysisProvenance).toMatchObject({ provider: "gemini", source: "client-reported" });
    expect(screen.getAllByText("已手動修正").length).toBeGreaterThan(0);
    expect(screen.queryByText(/你食了/)).not.toBeInTheDocument();
    const service = new NutritionService(new LocalNutritionProvider());
    const corrected = service.calculateMeal([draft.items[0]]);
    const original = service.calculateMeal([onDraftChange.mock.calls[0][0].items[0]]);
    expect(corrected.totals.calories).not.toEqual(original.totals.calories);
  });

  it("recalculates nutrition from a corrected portion", async () => {
    const user = userEvent.setup();
    const onDraftChange = await analyze(user);
    const minimum = screen.getByLabelText("最少份量");
    const maximum = screen.getByLabelText("最多份量");
    await user.clear(minimum);
    await user.type(minimum, "180");
    fireEvent.blur(minimum);
    await user.clear(maximum);
    await user.type(maximum, "180");
    fireEvent.blur(maximum);
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0].items[0].portionMax).toBe(180));
    const draft = onDraftChange.mock.lastCall?.[0];
    if (!draft) throw new Error("missing draft");
    expect(draft.items[0]).toMatchObject({ portionMin: 180, portionMax: 180 });
    expect(draft.analysis.foods[0]).toMatchObject({ portionMin: 280, portionMax: 420 });
    const service = new NutritionService(new LocalNutritionProvider());
    expect(service.calculateMeal([draft.items[0]]).totals.calories.max)
      .toBeLessThan(service.calculateMeal([onDraftChange.mock.calls[0][0].items[0]]).totals.calories.max);
  });

  it("drops a removed AI item from the current meal without erasing the original analysis", async () => {
    const user = userEvent.setup();
    const analysis = {
      ...chickenAnalysis,
      foods: [chickenAnalysis.foods[0], { ...demoFoodAnalysis.foods[0], displayName: "白飯", normalizedName: "cooked white rice" }],
    };
    const onDraftChange = await analyze(user, analysis);
    await user.click(screen.getByRole("button", { name: "刪除 白飯" }));
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0].items).toHaveLength(1));
    const draft = onDraftChange.mock.lastCall?.[0];
    if (!draft) throw new Error("missing draft");
    expect(draft.items.map((item: { displayName: string }) => item.displayName)).toEqual(["烤雞肉"]);
    expect(draft.analysis.foods.map((food: { displayName: string }) => food.displayName)).toEqual(["烤雞肉", "白飯"]);
  });

  it("adds an omitted food without writing it back into the original analysis", async () => {
    const user = userEvent.setup();
    const onDraftChange = await analyze(user);
    await user.click(screen.getByRole("button", { name: "新增食物" }));
    const names = screen.getAllByLabelText("食物名稱");
    await user.type(names[1]!, "白飯");
    const minimums = screen.getAllByLabelText("最少份量");
    const maximums = screen.getAllByLabelText("最多份量");
    await user.type(minimums[1]!, "100");
    fireEvent.blur(minimums[1]!);
    await user.type(maximums[1]!, "100");
    fireEvent.blur(maximums[1]!);
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0].items).toHaveLength(2));
    const draft = onDraftChange.mock.lastCall?.[0];
    if (!draft) throw new Error("missing draft");
    expect(draft.items[1].displayName).toBe("白飯");
    expect(draft.items[1].nutritionMatch.profile.canonicalName).toBe("rice");
    expect(draft.analysis.foods).toHaveLength(1);
    expect(draft.analysis.foods[0].displayName).toBe("烤雞肉");
  });
});
