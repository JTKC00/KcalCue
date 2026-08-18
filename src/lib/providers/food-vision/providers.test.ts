import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateContentMock, MockApiError } = vi.hoisted(() => {
  class HoistedMockApiError extends Error {
    constructor(public readonly status: number, message = `API error ${status}`) {
      super(message);
    }
  }

  return {
    generateContentMock: vi.fn(),
    MockApiError: HoistedMockApiError,
  };
});

vi.mock("@google/genai", () => ({
  ApiError: MockApiError,
  GoogleGenAI: class MockGoogleGenAI {
    readonly models = { generateContent: generateContentMock };
  },
}));

import { foodAnalysisJsonSchema } from "@/lib/domain/food-analysis";
import { DemoFoodVisionProvider, demoFoodAnalysis } from "./demo";
import {
  GEMINI_ABORT_TIMEOUT_MS,
  GEMINI_HTTP_TIMEOUT_MS,
  GeminiFoodVisionProvider,
} from "./gemini";

describe("DemoFoodVisionProvider", () => {
  it("returns a validated independent copy of the deterministic demo result", async () => {
    const provider = new DemoFoodVisionProvider();
    const first = await provider.analyzeImage({
      data: "unused-demo-input",
      mimeType: "image/jpeg",
    });
    const second = await provider.analyzeImage({
      data: "another-unused-demo-input",
      mimeType: "image/png",
    });

    expect(first).toEqual(demoFoodAnalysis);
    expect(second).toEqual(demoFoodAnalysis);
    expect(first).not.toBe(demoFoodAnalysis);
    expect(first.foods).not.toBe(second.foods);
  });
});

describe("GeminiFoodVisionProvider structured response handling", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function provider(): GeminiFoodVisionProvider {
    return new GeminiFoodVisionProvider({
      apiKey: "test-only-key",
      model: "test-only-model",
    });
  }

  it("maps malformed JSON to an invalid_response error without a network call", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "{not-json" });

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/webp" }),
    ).rejects.toMatchObject({
      name: "FoodVisionError",
      code: "invalid_response",
      message: "Gemini returned malformed JSON.",
    });

    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it("maps schema-invalid structured JSON to an invalid_response error", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({
        analysisStatus: "success",
        foods: [],
        uncertaintyReasons: [],
        visibleEvidence: [],
        estimatedInformation: [],
        unknownInformation: [],
      }),
    });

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({
      name: "FoodVisionError",
      code: "invalid_response",
      message: "Gemini returned data that failed server validation.",
    });

    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it("rejects an empty model response", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "" });

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses the configured model, inline image and JSON Schema output", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify(demoFoodAnalysis),
    });

    await expect(
      provider().analyzeImage({ data: "raw-base64", mimeType: "image/png" }),
    ).resolves.toEqual(demoFoodAnalysis);

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-only-model",
        contents: expect.arrayContaining([
          {
            inlineData: {
              data: "raw-base64",
              mimeType: "image/png",
            },
          },
        ]),
        config: expect.objectContaining({
          responseMimeType: "application/json",
          responseJsonSchema: expect.any(Object),
        }),
      }),
    );

    const request = generateContentMock.mock.calls[0]?.[0];
    expect(request.config).not.toHaveProperty("temperature");
    expect(request.config).not.toHaveProperty("topP");
    expect(request.config).not.toHaveProperty("topK");
    expect(request.config.httpOptions.timeout).toBe(GEMINI_HTTP_TIMEOUT_MS);
    expect(request.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(GEMINI_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(GEMINI_ABORT_TIMEOUT_MS).toBeGreaterThan(GEMINI_HTTP_TIMEOUT_MS);
    expect(request.config.responseJsonSchema).toEqual(foodAnalysisJsonSchema);
  });

  it("accepts optional null fields from Gemini without loosening Zod rules", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({
        ...demoFoodAnalysis,
        foods: demoFoodAnalysis.foods.map((food) => ({
          ...food,
          preparationMethod: null,
          notes: null,
        })),
      }),
    });

    await expect(
      provider().analyzeImage({ data: "raw-base64", mimeType: "image/jpeg" }),
    ).resolves.toMatchObject({ analysisStatus: "success" });
  });

  it("attaches a safe diagnostic for malformed JSON", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "{not-json" });

    const error = await provider()
      .analyzeImage({ data: "abc", mimeType: "image/webp" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "FoodVisionError",
      code: "invalid_response",
      diagnostic: {
        stage: "parse_json",
        model: "test-only-model",
        imageMimeType: "image/webp",
        imageByteSize: 2,
      },
    });
    expect(JSON.stringify(error)).not.toMatch(/test-only-key|raw-base64|AIza/);
  });

  it("classifies Gemini HTTP 400 invalid argument as unknown and records the Gemini code", async () => {
    generateContentMock.mockRejectedValueOnce(
      new MockApiError(
        400,
        JSON.stringify({
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            status: "INVALID_ARGUMENT",
          },
        }),
      ),
    );

    const error = await provider()
      .analyzeImage({ data: "abc", mimeType: "image/jpeg" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "FoodVisionError",
      code: "unknown",
      diagnostic: {
        stage: "gemini_request",
        httpStatus: 400,
        geminiErrorCode: "INVALID_ARGUMENT",
        safeMessage: "Request contains an invalid argument.",
      },
    });
  });

  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [404, "model_unavailable"],
    [429, "rate_limited"],
    [400, "unknown"],
    [413, "image_rejected"],
    [415, "image_rejected"],
    [500, "service_unavailable"],
    [503, "service_unavailable"],
    [504, "network_timeout"],
  ])("maps Gemini HTTP %i to %s", async (status, code) => {
    generateContentMock.mockRejectedValueOnce(new MockApiError(status));

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ name: "FoodVisionError", code });
  });

  it.each([
    ["API key not valid. Please pass a valid API key.", "invalid_key"],
    ["The requested model is not supported", "model_unavailable"],
    ["Unsupported image MIME type", "image_rejected"],
  ])("classifies Gemini HTTP 400 from its message: %s", async (message, code) => {
    generateContentMock.mockRejectedValueOnce(new MockApiError(400, message));

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ name: "FoodVisionError", code });
  });

  it("maps timeout aborts separately from unknown failures", async () => {
    generateContentMock.mockRejectedValueOnce(
      new DOMException("Timed out", "TimeoutError"),
    );
    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "network_timeout" });

    generateContentMock.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "unknown" });
  });
});
