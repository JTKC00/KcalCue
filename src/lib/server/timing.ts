export type SafeTimingOperation = "food-vision" | "nutrition-resolve";

export interface SafeTimingDiagnostic {
  operation: SafeTimingOperation;
  mode?: string;
  provider?: string;
  imageMimeType?: string;
  imageByteSize?: number;
  foodVisionMs?: number;
  nutritionResolveMs?: number;
  totalMs: number;
  resolvedCount?: number;
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/** Logs only operation metadata and timings; never food names, image bytes, or secrets. */
export function logSafeTiming(diagnostic: SafeTimingDiagnostic): void {
  console.error("[kcalcue:timing]", diagnostic);
}
