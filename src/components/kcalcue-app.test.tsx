/** @vitest-environment jsdom */

import "../test/setup";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { KcalCueApp } from "./kcalcue-app";

function pngFile() {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "meal.png", {
    type: "image/png",
  });
}

describe("KcalCueApp analysis cancel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:meal"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns to the selected photo without treating cancel as an unknown error", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    render(<KcalCueApp initialProviderMode="demo" />);

    const libraryInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    expect(libraryInput).toBeDefined();
    await user.upload(libraryInput!, pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));

    expect(await screen.findByRole("button", { name: "取消分析" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消分析" }));

    expect(screen.getByRole("button", { name: /開始分析/ })).toBeEnabled();
    expect(screen.queryByText("今次未能完成分析")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("completes a demo analysis after cancel is not pressed", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ analysis: demoFoodAnalysis, mode: "demo" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    render(<KcalCueApp initialProviderMode="demo" />);
    const libraryInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    await user.upload(libraryInput!, pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));

    expect(await screen.findByRole("heading", { name: /約 .*kcal/ })).toBeInTheDocument();
    expect(screen.getByText("示範結果")).toBeInTheDocument();
  });

  it("does not show a late nutrition response after the user cancels", async () => {
    const user = userEvent.setup();
    let completeNutrition: (response: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/analyze") return Response.json({ mode: "live", analysis: {
        ...demoFoodAnalysis, foods: [{ ...demoFoodAnalysis.foods[0], displayName: "未知餐點", normalizedName: "未知餐點" }],
      } });
      return new Promise<Response>(resolve => { completeNutrition = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<KcalCueApp initialProviderMode="live" />);
    await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "取消分析" }));
    await act(async () => { completeNutrition(Response.json({ matches: [] })); });
    expect(screen.getByRole("button", { name: /開始分析/ })).toBeEnabled();
    expect(screen.queryByText("食物明細")).not.toBeInTheDocument();
  });
});
