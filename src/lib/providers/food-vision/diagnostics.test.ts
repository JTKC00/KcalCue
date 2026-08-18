import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64ByteLength,
  extractGeminiErrorDetails,
  logFoodVisionDiagnostic,
  sanitizeDiagnosticMessage,
} from "./diagnostics";

describe("food-vision diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts API keys, bearer tokens and long base64 from messages", () => {
    const message = [
      "status 400 GEMINI_API_KEY=AIzaSyDummyValueForTestsOnly123456",
      "Authorization: Bearer ya29.super-secret-token",
      "data: /9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    ].join(" ");

    const sanitized = sanitizeDiagnosticMessage(message);
    expect(sanitized).not.toMatch(/AIza/);
    expect(sanitized).not.toContain("ya29.super-secret-token");
    expect(sanitized).not.toContain("GEMINI_API_KEY=AIza");
    expect(sanitized).toContain("[redacted]");
  });

  it("extracts Gemini HTTP status and error code from an SDK JSON payload", () => {
    const error = Object.assign(new Error(
      JSON.stringify({
        error: {
          code: 400,
          message: "Request contains an invalid argument.",
          status: "INVALID_ARGUMENT",
        },
      }),
    ), { name: "ApiError", status: 400 });

    expect(extractGeminiErrorDetails(error)).toMatchObject({
      errorClass: "ApiError",
      httpStatus: 400,
      geminiErrorCode: "INVALID_ARGUMENT",
      safeMessage: "Request contains an invalid argument.",
    });
  });

  it("computes decoded image size from base64 without keeping the payload", () => {
    expect(base64ByteLength("YWJjZA==")).toBe(4);
    expect(base64ByteLength("")).toBe(0);
  });

  it("logs only the public-safe diagnostic fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logFoodVisionDiagnostic({
      stage: "gemini_request",
      errorClass: "ApiError",
      httpStatus: 400,
      geminiErrorCode: "INVALID_ARGUMENT",
      safeMessage: "Request contains an invalid argument.",
      model: "gemini-3.7-flash",
      imageMimeType: "image/jpeg",
      imageByteSize: 2048,
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe("[kcalcue:food-vision]");
    expect(spy.mock.calls[0]?.[1]).toEqual({
      stage: "gemini_request",
      errorClass: "ApiError",
      httpStatus: 400,
      geminiErrorCode: "INVALID_ARGUMENT",
      safeMessage: "Request contains an invalid argument.",
      model: "gemini-3.7-flash",
      imageMimeType: "image/jpeg",
      imageByteSize: 2048,
    });
    expect(JSON.stringify(spy.mock.calls[0])).not.toMatch(/AIza|inlineData|authorization/i);
  });
});
