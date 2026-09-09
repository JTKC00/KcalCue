import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  responsesCreateMock,
  MockAPIError,
  MockAPIConnectionError,
  MockAPIConnectionTimeoutError,
  MockAPIUserAbortError,
} = vi.hoisted(() => {
  class HoistedMockAPIError extends Error {
    readonly code: string | null = null;
    readonly type: string | undefined;
    readonly error: unknown;

    constructor(
      public readonly status: number,
      message = `API error ${status}`,
      error?: unknown,
    ) {
      super(message);
      this.name = "APIError";
      this.type = undefined;
      this.error = error;
    }
  }

  class HoistedMockAPIConnectionError extends Error {
    constructor(message = "Connection error.") {
      super(message);
      this.name = "APIConnectionError";
    }
  }

  class HoistedMockAPIConnectionTimeoutError extends HoistedMockAPIConnectionError {
    constructor(message = "Request timed out.") {
      super(message);
      this.name = "APIConnectionTimeoutError";
    }
  }

  class HoistedMockAPIUserAbortError extends HoistedMockAPIError {
    constructor(message = "Request was aborted.") {
      super(undefined as never, message);
      this.name = "APIUserAbortError";
    }
  }

  return {
    responsesCreateMock: vi.fn(),
    MockAPIError: HoistedMockAPIError,
    MockAPIConnectionError: HoistedMockAPIConnectionError,
    MockAPIConnectionTimeoutError: HoistedMockAPIConnectionTimeoutError,
    MockAPIUserAbortError: HoistedMockAPIUserAbortError,
  };
});

vi.mock("openai", () => ({
  __esModule: true,
  default: class MockOpenAI {
    readonly responses = { create: responsesCreateMock };
  },
  APIError: MockAPIError,
  APIConnectionError: MockAPIConnectionError,
  APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
  APIUserAbortError: MockAPIUserAbortError,
}));

import sharp from "sharp";
import { foodAnalysisJsonSchema } from "@/lib/domain/food-analysis";
import { DemoFoodVisionProvider, demoFoodAnalysis } from "./demo";
import {
  OPENAI_ABORT_TIMEOUT_MS,
  OPENAI_HTTP_TIMEOUT_MS,
  OpenAIFoodVisionProvider,
} from "./openai";
import { FOOD_VISION_SYSTEM_INSTRUCTION } from "./prompt";
import { createFoodVisionProvider, getFoodVisionProviderMode } from "./factory";

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

describe("OpenAIFoodVisionProvider structured response handling", () => {
  beforeEach(() => {
    responsesCreateMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function provider(): OpenAIFoodVisionProvider {
    return new OpenAIFoodVisionProvider({
      apiKey: "test-only-key",
      model: "test-only-model",
    });
  }

  it("includes the dish-versus-ingredient contract in the vision instruction", () => {
    expect(FOOD_VISION_SYSTEM_INSTRUCTION).toContain('identityLevel "dish"');
    expect(FOOD_VISION_SYSTEM_INSTRUCTION).toContain('identityLevel "ingredient"');
    expect(FOOD_VISION_SYSTEM_INSTRUCTION).toContain(
      "do not decompose it into generic rice",
    );
    expect(FOOD_VISION_SYSTEM_INSTRUCTION).toContain(
      "visibleIngredients must never become separate food entries",
    );
    expect(FOOD_VISION_SYSTEM_INSTRUCTION).toContain("Milk tea is a beverage dish");
  });

  it("maps malformed JSON to an invalid_response error without a network call", async () => {
    responsesCreateMock.mockResolvedValueOnce({ output_text: "{not-json" });

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/webp" }),
    ).rejects.toMatchObject({
      name: "FoodVisionError",
      code: "invalid_response",
      message: "OpenAI returned malformed JSON.",
    });

    expect(responsesCreateMock).toHaveBeenCalledOnce();
  });

  it("maps schema-invalid structured JSON to an invalid_response error", async () => {
    responsesCreateMock.mockResolvedValueOnce({
      output_text: JSON.stringify({
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
      message: "OpenAI returned data that failed server validation.",
    });

    expect(responsesCreateMock).toHaveBeenCalledOnce();
  });

  it("rejects an empty model response", async () => {
    responsesCreateMock.mockResolvedValueOnce({ output_text: "" });

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses the configured model, data URL image and strict JSON Schema output", async () => {
    responsesCreateMock.mockResolvedValueOnce({
      output_text: JSON.stringify(demoFoodAnalysis),
    });

    await expect(
      provider().analyzeImage({ data: "raw-base64", mimeType: "image/png" }),
    ).resolves.toEqual(demoFoodAnalysis);

    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-only-model",
        instructions: FOOD_VISION_SYSTEM_INSTRUCTION,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: expect.any(String) },
              {
                type: "input_image",
                image_url: "data:image/png;base64,raw-base64",
                detail: "auto",
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "food_analysis",
            strict: true,
            schema: foodAnalysisJsonSchema,
          },
        },
        max_output_tokens: 4_000,
        store: false,
      }),
      expect.objectContaining({
        maxRetries: 2,
        timeout: OPENAI_HTTP_TIMEOUT_MS,
      }),
    );

    const request = responsesCreateMock.mock.calls[0]?.[0];
    const options = responsesCreateMock.mock.calls[0]?.[1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal).not.toBe(request.signal);
    expect(OPENAI_ABORT_TIMEOUT_MS).toBeGreaterThan(OPENAI_HTTP_TIMEOUT_MS);
  });

  it("forwards cancellation to an in-flight OpenAI request", async () => {
    const controller = new AbortController();
    responsesCreateMock.mockImplementationOnce((_body, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new MockAPIUserAbortError()), { once: true });
        controller.abort();
      });
    });

    await expect(provider().analyzeImage(
      { data: "base64-data", mimeType: "image/png" },
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: "network_timeout" });
    expect(responsesCreateMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not send a request when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider().analyzeImage(
      { data: "base64-data", mimeType: "image/png" },
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: "network_timeout" });
    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it("keeps the provider abort deadline when a caller signal is supplied", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    responsesCreateMock.mockImplementationOnce((_body, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new MockAPIUserAbortError()), { once: true });
        deadline.abort();
      });
    });
    await expect(provider().analyzeImage(
      { data: "base64-data", mimeType: "image/png" },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: "network_timeout" });
    expect(timeout).toHaveBeenCalledWith(OPENAI_ABORT_TIMEOUT_MS);
  });

  it("converts HEIC/HEIF input to JPEG before sending it to OpenAI", async () => {
    responsesCreateMock.mockResolvedValueOnce({
      output_text: JSON.stringify(demoFoodAnalysis),
    });
    const png = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    await provider().analyzeImage({
      data: png.toString("base64"),
      mimeType: "image/heic",
    });

    const request = responsesCreateMock.mock.calls[0]?.[0];
    expect(request.input[0].content[1]).toMatchObject({
      type: "input_image",
      detail: "auto",
    });
    expect(request.input[0].content[1].image_url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it("strips unknown fields and nullable optional fields before validation", async () => {
    responsesCreateMock.mockResolvedValueOnce({
      output_text: JSON.stringify({
        ...demoFoodAnalysis,
        extraModelField: "ignored",
        foods: demoFoodAnalysis.foods.map((food) => ({
          ...food,
          preparationMethod: null,
          visibleIngredients: null,
          notes: null,
          calories: 999,
        })),
      }),
    });

    const analysis = await provider().analyzeImage({
      data: "raw-base64",
      mimeType: "image/jpeg",
    });

    expect(analysis).toMatchObject({
      analysisStatus: "success",
      foods: expect.any(Array),
    });
    expect(analysis).not.toHaveProperty("extraModelField");
    expect(analysis.foods[0]).not.toHaveProperty("calories");
    expect(analysis.foods[0]).not.toHaveProperty("preparationMethod");
    expect(analysis.foods[0]).not.toHaveProperty("visibleIngredients");
  });

  it("attaches a safe diagnostic for malformed JSON", async () => {
    responsesCreateMock.mockResolvedValueOnce({ output_text: "{not-json" });

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
    expect(JSON.stringify(error)).not.toMatch(/test-only-key|raw-base64|AIza|sk-/);
  });

  it("classifies OpenAI HTTP 400 invalid request as unknown and records the error code", async () => {
    responsesCreateMock.mockRejectedValueOnce(
      new MockAPIError(
        400,
        JSON.stringify({
          error: {
            message: "Request contains an invalid parameter.",
            type: "invalid_request_error",
            code: "invalid_parameter",
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
        stage: "openai_request",
        httpStatus: 400,
        openaiErrorCode: "invalid_parameter",
        safeMessage: "Request contains an invalid parameter.",
      },
    });
  });

  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [404, "model_unavailable"],
    [408, "network_timeout"],
    [422, "image_rejected"],
    [429, "rate_limited"],
    [400, "unknown"],
    [413, "image_rejected"],
    [415, "image_rejected"],
    [500, "service_unavailable"],
    [503, "service_unavailable"],
    [504, "network_timeout"],
  ])("maps OpenAI HTTP %i to %s", async (status, code) => {
    responsesCreateMock.mockRejectedValueOnce(new MockAPIError(status));

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ name: "FoodVisionError", code });
  });

  it.each([
    ["Incorrect API key provided", "invalid_key"],
    ["The model `gpt-5.6-luna` does not exist", "model_unavailable"],
    ["Unsupported image MIME type", "image_rejected"],
  ])("classifies OpenAI HTTP 400 from its message: %s", async (message, code) => {
    responsesCreateMock.mockRejectedValueOnce(new MockAPIError(400, message));

    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ name: "FoodVisionError", code });
  });

  it("maps connection and timeout failures separately from unknown failures", async () => {
    responsesCreateMock.mockRejectedValueOnce(new MockAPIConnectionTimeoutError());
    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "network_timeout" });

    responsesCreateMock.mockRejectedValueOnce(new MockAPIUserAbortError());
    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "network_timeout" });

    responsesCreateMock.mockRejectedValueOnce(new MockAPIConnectionError());
    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "service_unavailable" });

    responsesCreateMock.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(
      provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "unknown" });
  });
});


describe("food vision provider selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses Demo when the OpenAI key is missing", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(createFoodVisionProvider()).toBeInstanceOf(DemoFoodVisionProvider);
    expect(getFoodVisionProviderMode()).toBe("demo");
  });

  it("uses OpenAI when a key is configured", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    expect(createFoodVisionProvider()).toBeInstanceOf(OpenAIFoodVisionProvider);
    expect(getFoodVisionProviderMode()).toBe("live");
  });
});
