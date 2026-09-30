import sharp from "sharp";
import { FoodVisionError } from "./errors";
import type { FoodImageInput, SupportedImageMimeType } from "./types";

type OpenAIImageMimeType = Exclude<
  SupportedImageMimeType,
  "image/heic" | "image/heif"
>;

interface OpenAIImageInput {
  data: string;
  mimeType: OpenAIImageMimeType;
}

const MAX_HEIC_INPUT_PIXELS = 40_000_000;
const MAX_RASTER_PASSTHROUGH_PIXELS = 40_000_000;
const MAX_RASTER_INPUT_PIXELS = 50_000_000;
const MAX_RASTER_EDGE = 10_000;
const PREPARE_TIMEOUT_SECONDS = 15;
const PREPARE_QUEUE_WAIT_MS = 60_000;

// Serializing native decodes bounds per-process peak memory when requests overlap.
let imagePreparationTail: Promise<void> = Promise.resolve();

async function waitForPreparationTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Image preparation cancelled.", "AbortError");

  let timer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => rejectWait(new DOMException("Image preparation cancelled.", "AbortError"));
  let rejectWait!: (error: DOMException) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectWait = reject;
    timer = setTimeout(
      () => reject(new DOMException("Image preparation queue timed out.", "TimeoutError")),
      PREPARE_QUEUE_WAIT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, interrupted]);
    if (signal?.aborted) throw new DOMException("Image preparation cancelled.", "AbortError");
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function prepareImageOneAtATime(
  image: FoodImageInput,
  signal?: AbortSignal,
): Promise<OpenAIImageInput> {
  const previous = imagePreparationTail;
  let release!: () => void;
  imagePreparationTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await waitForPreparationTurn(previous, signal);
    signal?.throwIfAborted();
    return await prepareFoodVisionImage(image);
  } finally {
    // An aborted waiter returns at once but keeps its place until the prior
    // native operation completes. Releasing earlier would run decodes together.
    void previous.then(release, release);
  }
}

async function prepareFoodVisionImage(image: FoodImageInput): Promise<OpenAIImageInput> {
  const mimeType = image.mimeType;
  try {
    const input = sharp(Buffer.from(image.data, "base64"), {
      limitInputPixels: mimeType === "image/heic" || mimeType === "image/heif"
        ? MAX_HEIC_INPUT_PIXELS
        : MAX_RASTER_INPUT_PIXELS,
    }).timeout({ seconds: PREPARE_TIMEOUT_SECONDS });
    if (mimeType !== "image/heic" && mimeType !== "image/heif") {
      const metadata = await input.metadata();
      const expectedFormat = mimeType === "image/jpeg" ? "jpeg" : mimeType.slice(6);
      if (metadata.format !== expectedFormat) {
        throw new Error("Image format does not match its MIME type");
      }
      if (!metadata.width || !metadata.height ||
        metadata.width > MAX_RASTER_EDGE || metadata.height > MAX_RASTER_EDGE) {
        throw new Error("Image dimensions exceed the supported limit");
      }
      const pixels = metadata.width * metadata.height;
      if (pixels <= MAX_RASTER_PASSTHROUGH_PIXELS) {
        // metadata() alone accepts some truncated files. Decode every pixel
        // before the paid request while retaining normal uploads unchanged.
        await input.stats();
        return { data: image.data, mimeType };
      }

      // Modern phone photos can exceed 40 MP while remaining under 10 MiB.
      // JPEG shrink-on-load limits native memory and AI input size.
      const jpeg = await input
        .rotate()
        .resize(1600, 1600, {
          fit: "inside",
          withoutEnlargement: true,
          fastShrinkOnLoad: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer();
      return { data: jpeg.toString("base64"), mimeType: "image/jpeg" };
    }

    const jpeg = await input
      .rotate()
      .jpeg()
      .toBuffer();
    return { data: jpeg.toString("base64"), mimeType: "image/jpeg" };
  } catch (error) {
    throw new FoodVisionError(
      "image_rejected",
      "The image could not be decoded.",
      { cause: error },
    );
  }
}

