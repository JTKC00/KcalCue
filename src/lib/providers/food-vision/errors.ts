import type { FoodVisionDiagnostic } from "./diagnostics";

export type FoodVisionErrorCode =
  | "invalid_key"
  | "model_unavailable"
  | "network_timeout"
  | "rate_limited"
  | "service_unavailable"
  | "invalid_response"
  | "image_rejected"
  | "unknown";

export interface FoodVisionErrorOptions extends ErrorOptions {
  diagnostic?: FoodVisionDiagnostic;
}

export class FoodVisionError extends Error {
  readonly diagnostic?: FoodVisionDiagnostic;

  constructor(
    public readonly code: FoodVisionErrorCode,
    message: string,
    options?: FoodVisionErrorOptions,
  ) {
    super(message, options);
    this.name = "FoodVisionError";
    this.diagnostic = options?.diagnostic;
  }
}
