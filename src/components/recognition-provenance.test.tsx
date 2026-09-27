/** @vitest-environment jsdom */

import "../test/setup";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "@/content/zh-HK";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import type { FoodAnalysis } from "@/lib/domain/food-analysis";
import { newDraft, type MealDraft } from "@/lib/meals/types";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { KcalCueApp } from "./kcalcue-app";

function analyzedDraft(): MealDraft {
  const analysis: FoodAnalysis = {
    analysisStatus: "success",
    foods: [{
      displayName: "香蕉", normalizedName: "banana", identityLevel: "ingredient",
      portionMin: 100, portionMax: 150, unit: "g",
      recognitionConfidence: 0.95, portionConfidence: 0.85, uncertaintyReasons: [],
    }],
    uncertaintyReasons: [], visibleEvidence: ["相片中有香蕉。"],
    estimatedInformation: [], unknownInformation: [],
  };
  const provider = new LocalNutritionProvider();
  const items = createEditableFoodItems(analysis.foods, analysis.foods.map(food => provider.resolve(food)));
  return { ...newDraft(), mode: "live", analysis, items, originalItems: structuredClone(items) };
}

function card(index = 0) {
  return within(screen.getAllByLabelText("食物名稱")[index].closest("article")!);
}

function confidencePanel() {
  return document.querySelector(".confidence-panel")!;
}

describe("recognition provenance in the meal editor", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network expected in provenance tests"); }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("identifies a manual meal without inventing an AI confidence score", () => {
    render(<KcalCueApp initialProviderMode="demo" manual />);
    fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: "白飯" } });
    expect(card().getByText("手動輸入")).toBeInTheDocument();
    expect(screen.queryByText(/AI 辨認/)).not.toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("食物來源手動輸入");
    expect(confidencePanel()).not.toHaveClass("confidence-panel-low");
    expect(screen.queryByText(copy.coarseEstimate)).not.toBeInTheDocument();
    expect(card().getByText("營養資料：高")).toBeInTheDocument();
  });

  it("keeps a manual addition out of the original AI confidence aggregate", () => {
    render(<KcalCueApp initialProviderMode="live" initialDraft={analyzedDraft()} />);
    fireEvent.click(screen.getByRole("button", { name: /新增食物/ }));
    fireEvent.change(screen.getAllByLabelText("食物名稱")[1], { target: { value: "白飯" } });
    expect(card(0).getByText("AI 辨認：高")).toBeInTheDocument();
    expect(card(1).getByText("手動輸入")).toBeInTheDocument();
    expect(card(1).queryByText(/AI 辨認/)).not.toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("AI 辨認（未修改項目）高（1 / 2 項）");
    expect(confidencePanel()).not.toHaveClass("confidence-panel-low");
    expect(screen.queryByText(copy.coarseEstimate)).not.toBeInTheDocument();
  });

  it("labels an identity correction after editing and after reopening the saved draft", () => {
    const draft = analyzedDraft();
    const changed = vi.fn();
    const first = render(<KcalCueApp initialProviderMode="live" initialDraft={draft} onDraftChange={changed} />);
    fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: "白飯" } });
    expect(card().getByText("已手動修正")).toBeInTheDocument();
    expect(screen.queryByText(/AI 辨認/)).not.toBeInTheDocument();
    const correction = changed.mock.lastCall![0];
    expect(correction.analysis).toEqual(draft.analysis);
    expect(correction.items[0].recognitionConfidence).toBe(0.95);
    first.unmount();
    render(<KcalCueApp initialProviderMode="live" initialDraft={{ ...draft, ...correction, version: 1 }} />);
    expect(card().getByText("已手動修正")).toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("食物來源已手動修正");
    expect(card().getByText("營養資料：高")).toBeInTheDocument();
  });

  it("retains original AI recognition after a portion-only edit or formatting-only name edit", () => {
    render(<KcalCueApp initialProviderMode="live" initialDraft={analyzedDraft()} />);
    const maximum = screen.getByLabelText("最多份量");
    fireEvent.change(maximum, { target: { value: "180" } });
    fireEvent.blur(maximum);
    expect(maximum).toHaveValue(180);
    fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: "  香蕉  " } });
    expect(card().getByText("AI 辨認：高")).toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("AI 辨認高");
    expect(card().queryByText("已手動修正")).not.toBeInTheDocument();
  });

  it("does not infer AI confidence from a legacy item without its original analysis", () => {
    render(<KcalCueApp initialProviderMode="live" initialDraft={{ ...analyzedDraft(), analysis: null }} />);
    expect(card().getByText("未有 AI 辨認資料")).toBeInTheDocument();
    expect(card().queryByText(/AI 辨認：/)).not.toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("食物來源未有 AI 辨認資料");
  });

  it("labels demonstration confidence as sample data instead of an actual AI result", () => {
    render(<KcalCueApp initialProviderMode="demo" initialDraft={{ ...analyzedDraft(), mode: "demo" }} />);
    expect(card().getByText("示範資料")).toBeInTheDocument();
    expect(screen.queryByText(/AI 辨認/)).not.toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("食物來源示範資料");
  });

  it("uses the immutable original score rather than an editable item score", () => {
    const draft = analyzedDraft();
    draft.analysis!.foods[0].recognitionConfidence = 0.3;
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft} />);
    expect(card().getByText("AI 辨認：低")).toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("AI 辨認低");
  });

  it("does not keep an AI badge when the identity level changed without renaming", () => {
    const draft = analyzedDraft();
    draft.items[0] = { ...draft.items[0], identityLevel: "dish" };
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft} />);
    expect(card().getByText("已手動修正")).toBeInTheDocument();
    expect(card().queryByText(/AI 辨認：/)).not.toBeInTheDocument();
  });

  it("uses stable IDs after reordering and deleting foods", () => {
    const draft = analyzedDraft();
    draft.analysis!.foods.push({
      ...draft.analysis!.foods[0], displayName: "白飯", normalizedName: "cooked white rice",
      recognitionConfidence: 0.3,
    });
    const provider = new LocalNutritionProvider();
    draft.items = createEditableFoodItems(draft.analysis!.foods, draft.analysis!.foods.map(food => provider.resolve(food)));
    draft.originalItems = structuredClone(draft.items);
    draft.items.reverse();
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft} />);
    expect(card(0).getByText("AI 辨認：低")).toBeInTheDocument();
    expect(card(1).getByText("AI 辨認：高")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刪除 白飯" }));
    expect(screen.getByLabelText("食物名稱")).toHaveValue("香蕉");
    expect(card().getByText("AI 辨認：高")).toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("AI 辨認高");
  });

  it("does not treat originalItems as proof that added foods were recognized by AI", () => {
    const draft = analyzedDraft();
    const added = { ...draft.items[0], displayName: "白飯", normalizedName: "rice", recognitionConfidence: 0.99 };
    draft.items.push({ ...added, id: "manual-saved-addition" }, { ...added, id: "legacy-unmapped-addition" });
    draft.originalItems = structuredClone(draft.items);
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft} />);
    expect(card(1).getByText("手動輸入")).toBeInTheDocument();
    expect(card(2).getByText("未有 AI 辨認資料")).toBeInTheDocument();
    expect(card(1).queryByText(/AI 辨認：/)).not.toBeInTheDocument();
    expect(card(2).queryByText(/AI 辨認：/)).not.toBeInTheDocument();
    expect(confidencePanel()).toHaveTextContent("AI 辨認（未修改項目）高（1 / 3 項）");
  });

  it("keeps the original AI badge when only normalizedName uses a different language", () => {
    const draft = analyzedDraft();
    draft.items[0].normalizedName = "香蕉";
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft} />);
    expect(card().getByText("AI 辨認：高")).toBeInTheDocument();
    expect(card().queryByText("已手動修正")).not.toBeInTheDocument();
  });
});
