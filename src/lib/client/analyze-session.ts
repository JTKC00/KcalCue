export const LOADING_STEP_PORTION_MS = 8_000;
export const LOADING_STEP_NUTRITION_MS = 20_000;
export const DEMO_ANALYZE_DELAY_MS = 650;

export function loadingStepIndex(elapsedMs: number): number {
  if (elapsedMs >= LOADING_STEP_NUTRITION_MS) return 2;
  if (elapsedMs >= LOADING_STEP_PORTION_MS) return 1;
  return 0;
}

export function loadingStepClass(current: number, index: number): string {
  if (index === current) return "active";
  if (index < current) return "done";
  return "";
}

export type AnalyzeAbortOutcome = "timeout" | "silent";

export function analyzeAbortOutcome(reason: unknown): AnalyzeAbortOutcome {
  return reason === "timeout" ? "timeout" : "silent";
}
