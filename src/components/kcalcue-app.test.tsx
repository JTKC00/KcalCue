/** @vitest-environment jsdom */

import "../test/setup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { copy } from "@/content/zh-HK";
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
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("clears the parent photo when an oversized replacement is rejected", async () => {
    const user = userEvent.setup();
    const onPhotoSelected = vi.fn();
    render(<KcalCueApp initialProviderMode="demo" onPhotoSelected={onPhotoSelected} />);

    const libraryInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    const first = pngFile();
    await user.upload(libraryInput, first);
    expect(onPhotoSelected).toHaveBeenCalledWith(first);

    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    await user.upload(libraryInput, oversized);

    expect(onPhotoSelected).toHaveBeenLastCalledWith(null);
    expect(screen.queryByAltText("已選擇的餐點相片預覽")).not.toBeInTheDocument();
  });

  it("clears the parent photo when a replacement has an unsupported format", async () => {
    const user = userEvent.setup();
    const onPhotoSelected = vi.fn();
    render(<KcalCueApp initialProviderMode="demo" onPhotoSelected={onPhotoSelected} />);
    const libraryInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    await user.upload(libraryInput, pngFile());

    fireEvent.change(libraryInput, {
      target: { files: [new File(["image"], "meal.tiff", { type: "image/tiff" })] },
    });

    expect(onPhotoSelected).toHaveBeenLastCalledWith(null);
    expect(screen.queryByAltText("已選擇的餐點相片預覽")).not.toBeInTheDocument();
  });

  it("clears the parent photo when the replacement preview cannot be created", async () => {
    const user = userEvent.setup();
    const onPhotoSelected = vi.fn();
    render(<KcalCueApp initialProviderMode="demo" onPhotoSelected={onPhotoSelected} />);
    const libraryInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    await user.upload(libraryInput, pngFile());
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error("preview failed"); });

    await user.upload(libraryInput, new File(["second"], "second.png", { type: "image/png" }));

    expect(onPhotoSelected).toHaveBeenLastCalledWith(null);
    expect(screen.queryByAltText("已選擇的餐點相片預覽")).not.toBeInTheDocument();
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

  it("keeps an unknown personal portion blank until the user enters their own amount", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => Response.json({ mode: "live", analysis: {
      ...demoFoodAnalysis,
      foods: [{ ...demoFoodAnalysis.foods[0], portionMin: null, portionMax: null }],
    } }));
    vi.stubGlobal("fetch", fetchMock);
    const onDraftChange = vi.fn();
    render(<KcalCueApp initialProviderMode="live" onDraftChange={onDraftChange} />);
    await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));
    expect(await screen.findByRole("heading", { name: "暫未能計算" })).toBeInTheDocument();
    expect(screen.getByText(/請核對食物名稱；現有資料不足以判斷你吃了多少/)).toBeInTheDocument();
    expect(screen.getByLabelText("最少份量")).toHaveValue(null);
    expect(onDraftChange.mock.lastCall?.[0].items[0]).toMatchObject({ portionMin: null, portionMax: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText("最少份量"), "100");
    await user.tab();
    expect(await screen.findByRole("heading", { name: /約 .*kcal/ })).toBeInTheDocument();
    expect(onDraftChange.mock.lastCall?.[0].items[0]).toMatchObject({ portionMin: 100, portionMax: 100 });
  });

  it("does not show a late nutrition response after the user starts another meal", async () => {
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
    expect(screen.getByText("AI 分析結果")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "記另一餐" }));
    await act(async () => { completeNutrition(Response.json({ matches: [] })); });
    expect(screen.getByRole("heading", { name: /一張相/ })).toBeInTheDocument();
    expect(screen.queryByText("食物明細")).not.toBeInTheDocument();
  });

  it("shows a completed AI result before slow nutrition and never retries AI when nutrition times out", async () => {
    const user = userEvent.setup();
    const timerSpy = vi.spyOn(window, "setTimeout");
    let completeNutrition: (response: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/analyze") return Response.json({ mode: "live", analysis: {
        ...demoFoodAnalysis, foods: [{ ...demoFoodAnalysis.foods[0], displayName: "帶子", normalizedName: "scallops" }],
      } });
      return new Promise<Response>(resolve => { completeNutrition = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onDraftChange = vi.fn();
    render(<KcalCueApp initialProviderMode="live" onDraftChange={onDraftChange} />);
    await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(screen.getByText("AI 分析結果")).toBeInTheDocument();
    expect(screen.getByText(/正在補查營養參考/)).toBeInTheDocument();
    const nutritionTimeout = timerSpy.mock.calls.find(([, ms]) => ms === 15_000)?.[0];
    expect(typeof nutritionTimeout).toBe("function");
    await act(async () => { if (typeof nutritionTimeout === "function") nutritionTimeout(); });
    expect(screen.getByText("AI 分析結果")).toBeInTheDocument();
    expect(screen.queryByText(/正在補查營養參考/)).not.toBeInTheDocument();
    expect(onDraftChange.mock.lastCall?.[0].items[0].nutritionMatch.reasons[0])
      .toBe(copy.nutritionLookupFailed);
    expect(screen.queryByText("今次未能完成分析")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/analyze")).toHaveLength(1);

    await act(async () => { completeNutrition(Response.json({ matches: [] })); });
    expect(screen.getByText("AI 分析結果")).toBeInTheDocument();
    expect(onDraftChange.mock.lastCall?.[0].items[0].nutritionMatch.reasons[0])
      .toBe(copy.nutritionLookupFailed);
  });

  it("adds a completed nutrition match to an unchanged AI food", async () => {
    const user = userEvent.setup();
    const remoteMatch = new LocalNutritionProvider().resolve(demoFoodAnalysis.foods[0]);
    let completeNutrition: (response: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/analyze") return Response.json({ mode: "live", analysis: {
        ...demoFoodAnalysis, foods: [{ ...demoFoodAnalysis.foods[0], displayName: "帶子", normalizedName: "scallops" }],
      } });
      return new Promise<Response>(resolve => { completeNutrition = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onDraftChange = vi.fn();
    render(<KcalCueApp initialProviderMode="live" onDraftChange={onDraftChange} />);
    await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(onDraftChange.mock.lastCall?.[0].items[0].nutritionMatch?.includedInTotal).toBe(false);

    await act(async () => { completeNutrition(Response.json({ matches: [remoteMatch] })); });
    expect(onDraftChange.mock.lastCall?.[0].items[0].nutritionMatch?.profile?.id)
      .toBe(remoteMatch.profile?.id);
    expect(screen.queryByText(/正在補查營養參考/)).not.toBeInTheDocument();
  });

  it("does not replace a user's name correction with a late nutrition match", async () => {
    const user = userEvent.setup();
    const unknownFood = { ...demoFoodAnalysis.foods[0], displayName: "帶子", normalizedName: "scallops" };
    const remoteMatch = new LocalNutritionProvider().resolve(demoFoodAnalysis.foods[0]);
    expect(remoteMatch.includedInTotal).toBe(true);
    let completeNutrition: (response: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/analyze") return Response.json({ mode: "live", analysis: {
        ...demoFoodAnalysis, foods: [unknownFood],
      } });
      return new Promise<Response>(resolve => { completeNutrition = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onDraftChange = vi.fn();
    render(<KcalCueApp initialProviderMode="live" onDraftChange={onDraftChange} />);
    await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const name = screen.getByRole("combobox", { name: "食物名稱" });
    await user.clear(name);
    await user.type(name, "banana");
    const corrected = onDraftChange.mock.lastCall?.[0].items[0].nutritionMatch;
    expect(corrected?.includedInTotal).toBe(true);
    expect(corrected?.profile?.id).not.toBe(remoteMatch.profile?.id);

    await act(async () => { completeNutrition(Response.json({ matches: [remoteMatch] })); });
    expect(onDraftChange.mock.lastCall?.[0].items[0].nutritionMatch?.profile?.id)
      .toBe(corrected.profile.id);
    expect(name).toHaveValue("banana");
  });

  it("assigns a new attempt ID to each explicit Live analysis without an automatic retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(
      { error: { code: "service_unavailable" } }, { status: 503 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    render(<KcalCueApp initialProviderMode="live" />);
    await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], pngFile());
    await user.click(screen.getByRole("button", { name: /開始分析/ }));
    expect(await screen.findByRole("heading", { name: "AI 服務暫時有問題" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "再試一次" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const ids = fetchMock.mock.calls.map(([, init]) => (init?.body as FormData).get("attemptId"));
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
