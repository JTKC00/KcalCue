import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import sharp, { type Sharp } from "sharp";
import { crc32 } from "node:zlib";
import { foodAnalysisJsonSchema } from "@/lib/domain/food-analysis";
import { DemoFoodVisionProvider, demoFoodAnalysis } from "./demo";
import {
  OPENAI_ABORT_TIMEOUT_MS,
  OPENAI_HTTP_TIMEOUT_MS,
  OpenAIFoodVisionProvider,
} from "./openai";
import { FOOD_VISION_SYSTEM_INSTRUCTION } from "./prompt";
import { createFoodVisionProvider, getFoodVisionProviderMode } from "./factory";
import { FOOD_VISION_ANALYSIS_VERSION, analysisProvenanceMetadataSchema } from "@/lib/domain/analysis-provenance";

type RasterMimeType = "image/jpeg" | "image/png" | "image/webp";
let rasterImages: Record<RasterMimeType, string>;

beforeAll(async () => {
  const redPixel = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "red" },
  }).png().toBuffer();
  rasterImages = {
    "image/jpeg": (await sharp(redPixel).jpeg().toBuffer()).toString("base64"),
    "image/png": redPixel.toString("base64"),
    "image/webp": (await sharp(redPixel).webp().toBuffer()).toString("base64"),
  };
});

function rasterWithHeaderDimensions(
  mimeType: RasterMimeType,
  width: number,
  height: number,
): string {
  const bytes = Buffer.from(rasterImages[mimeType], "base64");
  if (mimeType === "image/png") {
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  } else if (mimeType === "image/jpeg") {
    const startOfFrame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    expect(startOfFrame).toBeGreaterThan(0);
    bytes.writeUInt16BE(height, startOfFrame + 5);
    bytes.writeUInt16BE(width, startOfFrame + 7);
  } else {
    const frameHeader = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
    expect(frameHeader).toBeGreaterThan(0);
    bytes.writeUInt16LE(width, frameHeader + 3);
    bytes.writeUInt16LE(height, frameHeader + 5);
  }
  return bytes.toString("base64");
}

describe("DemoFoodVisionProvider", () => {
  it("labels a validated fixture without claiming a model", async () => {
    const onMetadata = vi.fn();
    await new DemoFoodVisionProvider().analyzeImage({ data: "", mimeType: "image/jpeg" }, { onMetadata });
    expect(onMetadata).toHaveBeenCalledOnce();
    expect(onMetadata.mock.calls[0][0]).toMatchObject({ provider: "demo", requestedModel: null,
      reportedModel: null, modelVersion: null, analysisVersion: FOOD_VISION_ANALYSIS_VERSION });
    expect(analysisProvenanceMetadataSchema.safeParse(onMetadata.mock.calls[0][0]).success).toBe(true);
  });
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

  it.each(["actual-provider-reported-model", undefined])("reports execution metadata after validation with response model %s", async (model) => {
    const onMetadata = vi.fn();
    responsesCreateMock.mockResolvedValueOnce({ output_text: JSON.stringify(demoFoodAnalysis), model });
    const analysis = await provider().analyzeImage({ data: "base64-data", mimeType: "image/jpeg" }, { onMetadata });
    expect(analysis).toEqual(demoFoodAnalysis);
    expect(analysis).not.toHaveProperty("analysisProvenance");
    expect(onMetadata).toHaveBeenCalledOnce();
    expect(onMetadata.mock.calls[0][0]).toMatchObject({ provider: "openai", requestedModel: "test-only-model",
      reportedModel: model ?? null, modelVersion: null, analysisVersion: FOOD_VISION_ANALYSIS_VERSION });
    expect(analysisProvenanceMetadataSchema.safeParse(onMetadata.mock.calls[0][0]).success).toBe(true);
  });

  it.each(["{bad-json", JSON.stringify({ foods: [] })])("does not emit metadata for invalid analysis %s", async (output_text) => {
    const onMetadata = vi.fn();
    responsesCreateMock.mockResolvedValueOnce({ output_text, model: "unvalidated" });
    await expect(provider().analyzeImage({ data: "", mimeType: "image/jpeg" }, { onMetadata }))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(onMetadata).not.toHaveBeenCalled();
  });

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
      provider().analyzeImage({ data: rasterImages["image/webp"], mimeType: "image/webp" }),
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
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
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
      provider().analyzeImage({ data: rasterImages["image/png"], mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses the configured model, data URL image and strict JSON Schema output", async () => {
    responsesCreateMock.mockResolvedValueOnce({
      output_text: JSON.stringify(demoFoodAnalysis),
    });

    await expect(
      provider().analyzeImage({ data: rasterImages["image/png"], mimeType: "image/png" }),
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
                image_url: `data:image/png;base64,${rasterImages["image/png"]}`,
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
        maxRetries: 0,
        timeout: OPENAI_HTTP_TIMEOUT_MS,
      }),
    );

    const request = responsesCreateMock.mock.calls[0]?.[0];
    const options = responsesCreateMock.mock.calls[0]?.[1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal).not.toBe(request.signal);
    expect(OPENAI_ABORT_TIMEOUT_MS).toBeGreaterThan(OPENAI_HTTP_TIMEOUT_MS);
  });

  it.each([500, 429, "connection"] as const)(
    "makes one SDK transport attempt for %s with the provider's default options",
    async (failure) => {
      // Use the installed SDK, with an in-process transport; never contact a provider.
      const { default: RealOpenAI } = await vi.importActual<typeof import("openai")>("openai");
      const transport = vi.fn(async () => {
        if (failure === "connection") throw new TypeError("Synthetic connection failure");
        return new Response(JSON.stringify({ error: { message: "Synthetic upstream failure" } }), {
          status: failure,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        });
      });
      const client = new RealOpenAI({ apiKey: "test-only", fetch: transport });
      responsesCreateMock.mockImplementation((body, options) => client.responses.create(body, options));

      await expect(provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }))
        .rejects.toMatchObject({ name: "FoodVisionError" });
      expect(responsesCreateMock).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it("forwards cancellation to an in-flight OpenAI request", async () => {
    const controller = new AbortController();
    responsesCreateMock.mockImplementationOnce((_body, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new MockAPIUserAbortError()), { once: true });
        controller.abort();
      });
    });

    await expect(provider().analyzeImage(
      { data: rasterImages["image/png"], mimeType: "image/png" },
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: "network_timeout" });
    expect(responsesCreateMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not send a request when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider().analyzeImage(
      { data: rasterImages["image/png"], mimeType: "image/png" },
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
      { data: rasterImages["image/png"], mimeType: "image/png" },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: "network_timeout" });
    expect(timeout).toHaveBeenCalledWith(OPENAI_ABORT_TIMEOUT_MS);
  });

  it.each(["image/jpeg", "image/png", "image/webp"] as const)(
    "forwards valid %s bytes unchanged",
    async (mimeType) => {
      responsesCreateMock.mockResolvedValueOnce({ output_text: JSON.stringify(demoFoodAnalysis) });
      await expect(provider().analyzeImage({ data: rasterImages[mimeType], mimeType }))
        .resolves.toMatchObject({ analysisStatus: "success" });
      expect(responsesCreateMock.mock.calls[0]?.[0].input[0].content[1].image_url)
        .toBe(`data:${mimeType};base64,${rasterImages[mimeType]}`);
    },
  );

  it.each(["image/jpeg", "image/png", "image/webp"] as const)(
    "rejects malformed %s before calling OpenAI",
    async (mimeType) => {
      await expect(provider().analyzeImage({
        data: Buffer.from("not-an-image").toString("base64"), mimeType,
      })).rejects.toMatchObject({
        code: "image_rejected", diagnostic: { stage: "image_prepare" },
      });
      expect(responsesCreateMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a truncated PNG whose metadata is readable but pixels cannot decode", async () => {
    const bytes = Buffer.from(rasterImages["image/png"], "base64");
    const idat = bytes.indexOf(Buffer.from("IDAT"));
    expect(idat).toBeGreaterThan(0);
    const truncated = bytes.subarray(0, idat + 8);
    await expect(sharp(truncated).metadata()).resolves.toMatchObject({ format: "png" });

    await expect(provider().analyzeImage({
      data: truncated.toString("base64"), mimeType: "image/png",
    })).rejects.toMatchObject({ code: "image_rejected", diagnostic: { stage: "image_prepare" } });
    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a raster image whose detected format differs from its declared MIME", async () => {
    await expect(provider().analyzeImage({
      data: rasterImages["image/png"], mimeType: "image/jpeg",
    })).rejects.toMatchObject({ code: "image_rejected", diagnostic: { stage: "image_prepare" } });
    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it.each(["image/jpeg", "image/png", "image/webp"] as const)(
    "rejects a compressed %s header over 50M pixels before OpenAI",
    async (mimeType) => {
      const data = rasterWithHeaderDimensions(mimeType, 8001, 6250);
      await expect(provider().analyzeImage({ data, mimeType })).rejects.toMatchObject({
        code: "image_rejected",
        cause: { message: "Input image exceeds pixel limit" },
        diagnostic: { stage: "image_prepare" },
      });
      expect(responsesCreateMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a real 48MP phone-sized JPEG and sends a bounded JPEG to OpenAI", async () => {
    const largeJpeg = await sharp({
      create: { width: 8064, height: 6048, channels: 3, background: "#a06030" },
    }).jpeg({ quality: 70 }).toBuffer();
    expect(largeJpeg.length).toBeLessThan(10 * 1024 * 1024);
    responsesCreateMock.mockResolvedValueOnce({ output_text: JSON.stringify(demoFoodAnalysis) });

    await expect(provider().analyzeImage({
      data: largeJpeg.toString("base64"), mimeType: "image/jpeg",
    })).resolves.toMatchObject({ analysisStatus: "success" });
    const url = responsesCreateMock.mock.calls[0]?.[0].input[0].content[1].image_url;
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    const sent = Buffer.from(url.split(",")[1], "base64");
    expect(sent.length).toBeLessThan(largeJpeg.length);
    expect(await sharp(sent).metadata()).toMatchObject({
      format: "jpeg", width: 1600, height: 1200,
    });
  });

  it("serializes native image decodes across concurrent analyses", async () => {
    const originalStats = sharp.prototype.stats;
    let active = 0;
    let peak = 0;
    vi.spyOn(sharp.prototype, "stats").mockImplementation(async function (this: Sharp) {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return await originalStats.call(this);
      } finally {
        active -= 1;
      }
    });
    responsesCreateMock.mockResolvedValue({ output_text: JSON.stringify(demoFoodAnalysis) });

    await Promise.all([
      provider().analyzeImage({ data: rasterImages["image/png"], mimeType: "image/png" }),
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
    ]);
    expect(peak).toBe(1);
    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
  });

  it("does not decode or call OpenAI for a request cancelled while waiting to prepare", async () => {
    const originalStats = sharp.prototype.stats;
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const stats = vi.spyOn(sharp.prototype, "stats").mockImplementationOnce(async function (this: Sharp) {
      begin();
      await held;
      return originalStats.call(this);
    });
    responsesCreateMock.mockResolvedValue({ output_text: JSON.stringify(demoFoodAnalysis) });

    const first = provider().analyzeImage({ data: rasterImages["image/png"], mimeType: "image/png" });
    await started;
    const controller = new AbortController();
    const cancelled = provider().analyzeImage(
      { data: rasterImages["image/jpeg"], mimeType: "image/jpeg" },
      { signal: controller.signal },
    );
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ code: "network_timeout" });
    controller.abort();
    release();
    await expect(first).resolves.toMatchObject({ analysisStatus: "success" });
    await cancelledResult;
    expect(stats).toHaveBeenCalledOnce();
    expect(responsesCreateMock).toHaveBeenCalledOnce();
  });

  it.each(["image/heic", "image/heif"] as const)("converts the %s branch to JPEG with a small PNG fixture", async (mimeType) => {
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
      mimeType,
    });

    const request = responsesCreateMock.mock.calls[0]?.[0];
    expect(request.input[0].content[1]).toMatchObject({
      type: "input_image",
      detail: "auto",
    });
    expect(request.input[0].content[1].image_url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    const output = Buffer.from(request.input[0].content[1].image_url.split(",")[1], "base64");
    expect(await sharp(output).metadata()).toMatchObject({ format: "jpeg", width: 1, height: 1 });
  });

  it.each([
    ["image/heic", 8000, true],
    ["image/heif", 8000, true],
    ["image/heic", 8001, false],
    ["image/heif", 8001, false],
  ] as const)("bounds %s preparation at width %i × 5000 (header-only probe)", async (mimeType, width, accepted) => {
    responsesCreateMock.mockResolvedValueOnce({ output_text: JSON.stringify(demoFoodAnalysis) });
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    }).png().toBuffer();
    const smallJpeg = await sharp(png).jpeg().toBuffer();
    png.writeUInt32BE(width, 16);
    png.writeUInt32BE(5000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);

    // Exercise the real sharp constructor/header validation without decoding a
    // 40M-pixel bitmap. The small fixture only probes this conversion branch;
    // it is not a real HEIC codec or device acceptance test.
    vi.spyOn(sharp.prototype, "toBuffer").mockImplementation(async function (this: Sharp) {
      await this.metadata();
      return smallJpeg;
    });
    const result = provider().analyzeImage({ data: png.toString("base64"), mimeType });
    if (accepted) {
      await expect(result).resolves.toMatchObject({ analysisStatus: "success" });
      expect(responsesCreateMock).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toMatchObject({
        code: "image_rejected",
        cause: { message: "Input image exceeds pixel limit" },
        diagnostic: { stage: "image_prepare" },
      });
      expect(responsesCreateMock).not.toHaveBeenCalled();
    }
  });

  it.each(["image/heic", "image/heif"] as const)("rejects corrupt %s preparation before calling OpenAI", async (mimeType) => {
    await expect(provider().analyzeImage({ data: Buffer.from("invalid-image").toString("base64"), mimeType }))
      .rejects.toMatchObject({ code: "image_rejected", diagnostic: { stage: "image_prepare" } });
    expect(responsesCreateMock).not.toHaveBeenCalled();
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
      data: rasterImages["image/jpeg"],
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
      .analyzeImage({ data: rasterImages["image/webp"], mimeType: "image/webp" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "FoodVisionError",
      code: "invalid_response",
      diagnostic: {
        stage: "parse_json",
        model: "test-only-model",
        imageMimeType: "image/webp",
        imageByteSize: Buffer.from(rasterImages["image/webp"], "base64").length,
      },
    });
    expect(JSON.stringify(error)).not.toMatch(/test-only-key|AIza|sk-/);
    expect(JSON.stringify(error)).not.toContain(rasterImages["image/webp"]);
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
      .analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" })
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
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ name: "FoodVisionError", code });
  });

  it.each([
    ["Incorrect API key provided", "invalid_key"],
    ["The model `gpt-5.6-luna` does not exist", "model_unavailable"],
    ["Unsupported image MIME type", "image_rejected"],
  ])("classifies OpenAI HTTP 400 from its message: %s", async (message, code) => {
    responsesCreateMock.mockRejectedValueOnce(new MockAPIError(400, message));

    await expect(
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ name: "FoodVisionError", code });
  });

  it("maps connection and timeout failures separately from unknown failures", async () => {
    responsesCreateMock.mockRejectedValueOnce(new MockAPIConnectionTimeoutError());
    await expect(
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "network_timeout" });

    responsesCreateMock.mockRejectedValueOnce(new MockAPIUserAbortError());
    await expect(
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "network_timeout" });

    responsesCreateMock.mockRejectedValueOnce(new MockAPIConnectionError());
    await expect(
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "service_unavailable" });

    responsesCreateMock.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(
      provider().analyzeImage({ data: rasterImages["image/jpeg"], mimeType: "image/jpeg" }),
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
