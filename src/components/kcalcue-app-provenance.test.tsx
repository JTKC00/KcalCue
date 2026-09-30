/** @vitest-environment jsdom */
import "../test/setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { provenance, provenanceMetadata } from "@/test/provenance-fixture";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { newDraft } from "@/lib/meals/types";
import { KcalCueApp } from "./kcalcue-app";

const analysis = { ...demoFoodAnalysis, foods: [demoFoodAnalysis.foods[0]] };
beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:meal"), revokeObjectURL: vi.fn() }));
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it.each([provenanceMetadata, undefined, { ...provenanceMetadata, analyzedAt: "invalid" }])(
  "accepts a valid analysis independently of optional metadata %j", async (metadata) => {
    const onDraftChange = vi.fn();
    const fetch = vi.fn(async () => Response.json({ analysis, mode: "live", analysisProvenance: metadata }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<KcalCueApp initialProviderMode="live" onDraftChange={onDraftChange} />);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "meal.png", { type: "image/png" });
    await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], file);
    await user.click(screen.getByRole("button", { name: /開始分析/ }));
    await screen.findByRole("heading", { name: /約 .*kcal/ });
    const expected = metadata === provenanceMetadata ? provenance : null;
    expect(onDraftChange.mock.lastCall![0]).toMatchObject({ analysis, analysisProvenance: expected, mode: "live" });
    fireEvent.change(screen.getByLabelText("最少份量"), { target: { value: "160" } });
    fireEvent.blur(screen.getByLabelText("最少份量"));
    await waitFor(() => expect(onDraftChange.mock.lastCall![0].items[0].portionMin).toBe(160));
    expect(onDraftChange.mock.lastCall![0].analysisProvenance).toEqual(expected);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("retains a restored analysis time while editing without invoking analysis again", async () => {
  const onDraftChange = vi.fn(), fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const draft = { ...newDraft(), mode: "live" as const, analysis, analysisProvenance: provenance,
    items: createEditableFoodItems(analysis.foods) };
  render(<KcalCueApp initialProviderMode="live" initialDraft={draft} onDraftChange={onDraftChange} />);
  expect(onDraftChange.mock.lastCall![0].analysisProvenance).toEqual(provenance);
  fireEvent.change(screen.getByLabelText("最少份量"), { target: { value: "160" } });
  fireEvent.blur(screen.getByLabelText("最少份量"));
  await waitFor(() => expect(onDraftChange.mock.lastCall![0].items[0].portionMin).toBe(160));
  expect(onDraftChange.mock.lastCall![0].analysisProvenance.analyzedAt).toBe(provenance.analyzedAt);
  expect(fetch).not.toHaveBeenCalled();
});

it("clears old analysis metadata when the user chooses manual entry after an unidentifiable new analysis", async () => {
  const onDraftChange = vi.fn();
  const unable = { ...analysis, analysisStatus: "unable_to_identify", foods: [] };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ analysis: unable, mode: "live", analysisProvenance: provenanceMetadata })));
  const user = userEvent.setup();
  render(<KcalCueApp initialProviderMode="live" onDraftChange={onDraftChange} />);
  await user.upload(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1],
    new File(["png"], "meal.png", { type: "image/png" }));
  await user.click(screen.getByRole("button", { name: /開始分析/ }));
  await user.click(await screen.findByRole("button", { name: "手動加入食物" }));
  expect(onDraftChange.mock.lastCall![0]).toMatchObject({ analysis: null, analysisProvenance: null, mode: "manual" });
});
