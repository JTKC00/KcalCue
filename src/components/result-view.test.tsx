/** @vitest-environment jsdom */

import "../test/setup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { ResultView } from "./result-view";

const noop = vi.fn();

function food(
  displayName: string,
  normalizedName: string,
  identityLevel: "dish" | "ingredient" = "ingredient",
) {
  return {
    displayName,
    normalizedName,
    identityLevel,
    portionMin: 100,
    portionMax: 150,
    unit: "g" as const,
    recognitionConfidence: 0.9,
    portionConfidence: 0.8,
    uncertaintyReasons: [],
  };
}

describe("ResultView coverage copy", () => {
  it("does not substitute reference calories for an invalid saved correction", () => {
    const provider = new LocalNutritionProvider();
    const foods = [food("白飯", "cooked white rice")];
    const items = createEditableFoodItems(foods, foods.map((item) => provider.resolve(item)));
    render(<ResultView analysis={null} items={items} mode="manual" calorieCorrection={{ kcal: 650, source: "ai" } as never} previewUrl={null} previewFailed={false} isHeic={false} onNameChange={noop} onPortionChange={noop} onUnitChange={noop} onPreset={noop} onDelete={noop} onAdd={noop} onReset={noop} />);
    expect(screen.getByRole("heading", { name: "暫未能計算" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("已存的手動卡路里無效");
    expect(screen.getByLabelText("主要營養素估算範圍")).toBeInTheDocument();
  });

  it.each([0, 650])("shows user kcal %s without inventing macros for an unknown food", (kcal) => {
    const provider = new LocalNutritionProvider();
    const foods = [food("自訂測試餐", "unknown custom meal", "dish")];
    const items = createEditableFoodItems(foods, foods.map((item) => provider.resolve(item)));
    render(<ResultView analysis={null} items={items} mode="manual" calorieCorrection={{ kcal, source: "user" }} previewUrl={null} previewFailed={false} isHeic={false} onNameChange={noop} onPortionChange={noop} onUnitChange={noop} onPreset={noop} onDelete={noop} onAdd={noop} onReset={noop} />);
    expect(screen.getByRole("heading", { name: `手動記錄：${kcal} kcal` })).toBeInTheDocument();
    expect(screen.queryByLabelText("主要營養素估算範圍")).not.toBeInTheDocument();
    expect(screen.getByText("營養參考不足；手動卡路里不代表營養素已確認。")).toBeInTheDocument();
  });

  it("keeps HEIC fallback actions on the result sidebar", () => {
    const provider = new LocalNutritionProvider();
    const foods = [food("白飯", "cooked white rice")];
    const items = createEditableFoodItems(
      foods,
      foods.map((item) => provider.resolve(item)),
    );

    render(
      <ResultView
        analysis={null}
        items={items}
        mode="demo"
        previewUrl={null}
        previewFailed
        isHeic
        onNameChange={noop}
        onPortionChange={noop}
        onUnitChange={noop}
        onPreset={noop}
        onDelete={noop}
        onAdd={noop}
        onReset={noop}
      />,
    );

    expect(screen.getByText("HEIC 相片已選擇")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "記另一餐" })).toBeInTheDocument();
  });

  it("explains partial coverage instead of hiding the meal total", () => {
    const provider = new LocalNutritionProvider();
    const foods = [
      food("白飯", "cooked white rice"),
      food("雞胸肉", "chicken breast"),
      food("青菜", "cooked leafy greens"),
      food("pizza", "pizza", "dish"),
    ];
    const items = createEditableFoodItems(
      foods,
      foods.map((item) => provider.resolve(item)),
    );

    render(
      <ResultView
        analysis={null}
        items={items}
        mode="live"
        previewUrl={null}
        previewFailed={false}
        isHeic={false}
        onNameChange={noop}
        onPortionChange={noop}
        onUnitChange={noop}
        onPreset={noop}
        onDelete={noop}
        onAdd={noop}
        onReset={noop}
      />,
    );

    expect(screen.getByRole("heading", { name: /kcal/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 / 4");
    expect(screen.getByRole("status")).toHaveTextContent("只包括");
  });

  it("hides the meal total when coverage is insufficient", () => {
    const provider = new LocalNutritionProvider();
    const foods = [food("香蕉", "banana"), food("pizza", "pizza", "dish")];
    const items = createEditableFoodItems(
      foods,
      foods.map((item) => provider.resolve(item)),
    );

    render(
      <ResultView
        analysis={null}
        items={items}
        mode="live"
        previewUrl={null}
        previewFailed={false}
        isHeic={false}
        onNameChange={noop}
        onPortionChange={noop}
        onUnitChange={noop}
        onPreset={noop}
        onDelete={noop}
        onAdd={noop}
        onReset={noop}
      />,
    );

    expect(screen.getByRole("heading", { name: "暫未能計算" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 / 2");
  });
});
