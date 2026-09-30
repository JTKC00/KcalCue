/** @vitest-environment jsdom */
import "../test/setup";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalorieCorrectionInput } from "./calorie-correction-input";
import type { MealCalorieCorrection } from "@/lib/meals/calories";

function Harness() {
  const [value, setValue] = useState<{ calorieInput: string | undefined; calorieCorrection: MealCalorieCorrection | null }>({ calorieInput: undefined, calorieCorrection: null });
  return <><CalorieCorrectionInput correction={value.calorieCorrection} input={value.calorieInput} onChange={setValue} /><output aria-label="目前手動值">{value.calorieCorrection?.kcal ?? "未知"}</output></>;
}

describe("whole-meal calorie input", () => {
  it("blocks malformed saved metadata until the user explicitly replaces or clears it", () => {
    render(<CalorieCorrectionInput correction={{ kcal: 650, source: "ai" } as never} onChange={() => {}} />);
    expect(screen.getByRole("spinbutton")).toBeInvalid();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps empty distinct from zero and explicitly restores reference estimates", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "自行填寫本餐卡路里" }));
    const field = screen.getByRole("spinbutton", { name: "手動卡路里（整餐 kcal）" });
    expect(field).toBeInvalid();
    expect(screen.getByLabelText("目前手動值")).toHaveTextContent("未知");
    fireEvent.change(field, { target: { value: "0" } });
    expect(field).toBeValid();
    expect(screen.getByLabelText("目前手動值")).toHaveTextContent("0");
    fireEvent.change(field, { target: { value: "650" } });
    expect(screen.getByLabelText("目前手動值")).toHaveTextContent("650");
    fireEvent.change(field, { target: { value: "" } });
    expect(field).toBeInvalid();
    expect(screen.getByLabelText("目前手動值")).toHaveTextContent("未知");
    fireEvent.click(screen.getByRole("button", { name: "恢復參考估算" }));
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByLabelText("目前手動值")).toHaveTextContent("未知");
  });

  it.each(["-1", "1.5", "20001"])("does not silently clamp invalid input %s", (raw) => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "自行填寫本餐卡路里" }));
    const field = screen.getByRole("spinbutton");
    fireEvent.change(field, { target: { value: raw } });
    expect(field).toHaveValue(Number(raw));
    expect(field).toBeInvalid();
    expect(screen.getByRole("alert")).toHaveTextContent("空白不代表零");
    expect(screen.getByLabelText("目前手動值")).toHaveTextContent("未知");
  });
});
