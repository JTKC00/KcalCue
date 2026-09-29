import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { generateContentMock, MockApiError } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    constructor(public readonly status: number, message = `API error ${status}`) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { generateContentMock: vi.fn(), MockApiError: HoistedApiError };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly models = { generateContent: generateContentMock };
  },
  ApiError: MockApiError,
  ThinkingLevel: { MEDIUM: "MEDIUM" },
}));

import sharp from "sharp";
import { demoFoodAnalysis } from "./demo";
import { FOOD_VISION_ANALYSIS_VERSION } from "@/lib/domain/analysis-provenance";
import { GeminiFoodVisionProvider, GEMINI_MAX_OUTPUT_TOKENS } from "./gemini";

let jpeg = "";

beforeAll(async () => {
  jpeg = (await sharp({
    create: { width: 1, height: 1, channels: 3, background: "red" },
  }).jpeg().toBuffer()).toString("base64");
});

function provider() {
  return new GeminiFoodVisionProvider({ apiKey: "test-only-gemini-key", model: "gemini-3.8-flash" });
}

function response(text: string) {
  return {
    text,
    modelVersion: "gemini-3.8-flash",
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 7,
      totalTokenCount: 23,
    },
  };
}

describe("GeminiFoodVisionProvider", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates a structured result and records Gemini provenance", async () => {
    generateContentMock.mockResolvedValueOnce(response(JSON.stringify(demoFoodAnalysis)));
    const onMetadata = vi.fn();
    const analysis = await provider().analyzeImage({ data: jpeg, mimeType: "image/jpeg" }, { onMetadata });
    expect(analysis.foods[0]?.displayName).toBe("白飯");
    expect(onMetadata.mock.calls[0][0]).toMatchObject({
      provider: "gemini",
      requestedModel: "gemini-3.8-flash",
      reportedModel: "gemini-3.8-flash",
      modelVersion: null,
      analysisVersion: FOOD_VISION_ANALYSIS_VERSION,
    });
    const request = generateContentMock.mock.calls[0][0];
    expect(request.model).toBe("gemini-3.8-flash");
    expect(request.config.thinkingConfig).toEqual({ thinkingLevel: "MEDIUM" });
    expect(request.config.maxOutputTokens).toBe(GEMINI_MAX_OUTPUT_TOKENS);
    expect(request.config.responseMimeType).toBe("application/json");
    expect(request.config.tools).toBeUndefined();
    expect(request.config.httpOptions.retryOptions.attempts).toBe(1);
    expect(request.contents[1].inlineData.mimeType).toBe("image/jpeg");
    expect(console.info).toHaveBeenCalledWith("[kcalcue:food-vision-usage]", expect.objectContaining({
      requestedModel: "gemini-3.8-flash",
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 23,
    }));
  });

  it("keeps a null portion and an unable-to-identify result", async () => {
    const unknown = {
      ...demoFoodAnalysis,
      foods: [{ ...demoFoodAnalysis.foods[0], portionMin: null, portionMax: null }],
    };
    generateContentMock.mockResolvedValueOnce(response(JSON.stringify(unknown)));
    const analysis = await provider().analyzeImage({ data: jpeg, mimeType: "image/jpeg" });
    expect(analysis.foods[0]).toMatchObject({ portionMin: null, portionMax: null });

    generateContentMock.mockResolvedValueOnce(response(JSON.stringify({
      analysisStatus: "unable_to_identify",
      foods: [],
      uncertaintyReasons: ["相片太模糊。"],
      visibleEvidence: ["只見碟子。"],
      estimatedInformation: [],
      unknownInformation: ["食物種類不明。"],
    })));
    const empty = await provider().analyzeImage({ data: jpeg, mimeType: "image/jpeg" });
    expect(empty).toMatchObject({ analysisStatus: "unable_to_identify", foods: [] });
  });

  it("rejects malformed JSON and schema-invalid results", async () => {
    generateContentMock.mockResolvedValueOnce(response("not-json"));
    await expect(provider().analyzeImage({ data: jpeg, mimeType: "image/jpeg" }))
      .rejects.toMatchObject({ code: "invalid_response" });

    generateContentMock.mockResolvedValueOnce(response(JSON.stringify({
      analysisStatus: "success",
      foods: [],
      uncertaintyReasons: [],
      visibleEvidence: [],
      estimatedInformation: [],
      unknownInformation: [],
    })));
    await expect(provider().analyzeImage({ data: jpeg, mimeType: "image/jpeg" }))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [404, "model_unavailable"],
    [429, "rate_limited"],
    [500, "service_unavailable"],
    [503, "service_unavailable"],
    [504, "network_timeout"],
  ])("maps Gemini HTTP %s to %s", async (status, code) => {
    generateContentMock.mockRejectedValueOnce(new MockApiError(status));
    await expect(provider().analyzeImage({ data: jpeg, mimeType: "image/jpeg" }))
      .rejects.toMatchObject({ code });
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it("maps abort and does not retry a failed request", async () => {
    const controller = new AbortController();
    generateContentMock.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });
    await expect(provider().analyzeImage(
      { data: jpeg, mimeType: "image/jpeg" },
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: "network_timeout" });
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it("returns the analysis when usage logging throws", async () => {
    vi.mocked(console.info).mockImplementation(() => { throw new Error("log failed"); });
    generateContentMock.mockResolvedValueOnce(response(JSON.stringify(demoFoodAnalysis)));
    await expect(provider().analyzeImage({ data: jpeg, mimeType: "image/jpeg" }))
      .resolves.toMatchObject({ analysisStatus: "success" });
    expect(generateContentMock).toHaveBeenCalledOnce();
  });
});
