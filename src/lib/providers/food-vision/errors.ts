export type FoodVisionErrorCode =
  | "invalid_key"
  | "model_unavailable"
  | "network_timeout"
  | "rate_limited"
  | "service_unavailable"
  | "invalid_response"
  | "image_rejected"
  | "unknown";

export class FoodVisionError extends Error {
  constructor(
    public readonly code: FoodVisionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FoodVisionError";
  }
}
