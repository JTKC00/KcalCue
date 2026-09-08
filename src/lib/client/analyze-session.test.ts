/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import {
  LOADING_STEP_NUTRITION_MS,
  LOADING_STEP_PORTION_MS,
  analyzeAbortOutcome,
  loadingStepClass,
  loadingStepIndex,
} from "./analyze-session";

describe("analyze session waiting feedback", () => {
  it("keeps the first loading step active until the portion delay", () => {
    expect(loadingStepIndex(0)).toBe(0);
    expect(loadingStepIndex(LOADING_STEP_PORTION_MS - 1)).toBe(0);
    expect(loadingStepIndex(LOADING_STEP_PORTION_MS)).toBe(1);
    expect(loadingStepIndex(LOADING_STEP_NUTRITION_MS)).toBe(2);
  });

  it("marks earlier steps done without implying server completion", () => {
    expect(loadingStepClass(1, 0)).toBe("done");
    expect(loadingStepClass(1, 1)).toBe("active");
    expect(loadingStepClass(1, 2)).toBe("");
  });

  it("treats user cancel as silent and timeout as a network timeout", () => {
    expect(analyzeAbortOutcome("cancelled")).toBe("silent");
    expect(analyzeAbortOutcome("superseded")).toBe("silent");
    expect(analyzeAbortOutcome("unmount")).toBe("silent");
    expect(analyzeAbortOutcome("timeout")).toBe("timeout");
  });
});
