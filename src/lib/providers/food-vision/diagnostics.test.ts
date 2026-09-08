import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64ByteLength,
  extractOpenAIErrorDetails,
  logFoodVisionDiagnostic,
  sanitizeDiagnosticMessage,
} from "./diagnostics";

describe("food-vision diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts API keys, bearer tokens and long base64 from messages", () => {
    const message = [
      "status 401 OPENAI_API_KEY=sk-proj-DummyValueForTestsOnly123456789",
      "Authorization: Bearer super-secret-token",
      "data: /9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    ].join(" ");

    const sanitized = sanitizeDiagnosticMessage(message);
    expect(sanitized).not.toMatch(/sk-proj-DummyValue/);
    expect(sanitized).not.toContain("super-secret-token");
    expect(sanitized).not.toContain("OPENAI_API_KEY=sk-");
    expect(sanitized).toContain("[redacted]");
  });

  it("extracts OpenAI HTTP status and error code from an SDK JSON payload", () => {
    const error = Object.assign(new Error(
      JSON.stringify({
        error: {
          code: 400,
          message: "Request contains an invalid parameter.",
          type: "invalid_request_error",
        },
      }),
    ), { name: "APIError", status: 400 });

    expect(extractOpenAIErrorDetails(error)).toMatchObject({
      errorClass: "APIError",
      httpStatus: 400,
      openaiErrorCode: "invalid_request_error",
      safeMessage: "Request contains an invalid parameter.",
    });
  });

  it("computes decoded image size from base64 without keeping the payload", () => {
    expect(base64ByteLength("YWJjZA==")).toBe(4);
    expect(base64ByteLength("")).toBe(0);
  });

  it("logs only the public-safe diagnostic fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logFoodVisionDiagnostic({
      stage: "openai_request",
      errorClass: "APIError",
      httpStatus: 400,
      openaiErrorCode: "invalid_request_error",
      safeMessage: "Request contains an invalid parameter.",
      model: "gpt-5.6-luna",
      imageMimeType: "image/jpeg",
      imageByteSize: 2048,
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe("[kcalcue:food-vision]");
    expect(spy.mock.calls[0]?.[1]).toEqual({
      stage: "openai_request",
      errorClass: "APIError",
      httpStatus: 400,
      openaiErrorCode: "invalid_request_error",
      safeMessage: "Request contains an invalid parameter.",
      model: "gpt-5.6-luna",
      imageMimeType: "image/jpeg",
      imageByteSize: 2048,
    });
    expect(JSON.stringify(spy.mock.calls[0])).not.toMatch(/sk-|input_image|authorization/i);
  });
});
