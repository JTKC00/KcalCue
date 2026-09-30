import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Credential } from "firebase-admin/app";
import { HttpError } from "@/lib/server/auth";
import { MAX_PHOTO_JPEG_BYTES } from "./photo-assets";

// The installed Storage SDK converts FileOptions.generation to Number. Use the
// documented JSON API for exact decimal generation strings instead. This
// adapter has no client-facing endpoint and does not enable uploads.
const exactGeneration = /^[1-9][0-9]{0,31}$/;
const photoObjectKey = /^meal-photos\/v1\/[A-Za-z0-9_-]{1,172}\/[0-9a-fA-F-]{36}\/[0-9a-fA-F-]{36}\.jpg$/;
const bucketName = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const metadataLimit = 32 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
const dimension = /^[1-9][0-9]{0,3}$/;

export function isExactPhotoGeneration(value: string) {
  return exactGeneration.test(value);
}

function objectUrl(bucket: string, key: string) {
  if (!bucketName.test(bucket) || !photoObjectKey.test(key))
    throw new HttpError(503, "photo_storage_unavailable");
  return new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`);
}

function generation(value: string) {
  if (!exactGeneration.test(value)) throw new HttpError(503, "photo_storage_unavailable");
  return value;
}

function parseMetadata(data: unknown, bucket: string, key: string, exact?: string): ExactPhotoMetadata {
  if (!data || typeof data !== "object") throw new HttpError(503, "photo_storage_unavailable");
  const value = data as Record<string, unknown>;
  if (value.bucket !== bucket || value.name !== key ||
      typeof value.generation !== "string" || !exactGeneration.test(value.generation) ||
      (exact !== undefined && value.generation !== exact) ||
      typeof value.size !== "string" || !/^[1-9][0-9]*$/.test(value.size) ||
      Number(value.size) > MAX_PHOTO_JPEG_BYTES ||
      value.contentType !== "image/jpeg")
    throw new HttpError(503, "photo_storage_unavailable");
  const custom = value.metadata && typeof value.metadata === "object"
    ? value.metadata as Record<string, unknown> : {};
  if (typeof custom.inputSha256 !== "string" || !sha256.test(custom.inputSha256) ||
      typeof custom.jpegSha256 !== "string" || !sha256.test(custom.jpegSha256) ||
      typeof custom.width !== "string" || !dimension.test(custom.width) || Number(custom.width) > 1600 ||
      typeof custom.height !== "string" || !dimension.test(custom.height) || Number(custom.height) > 1600)
    throw new HttpError(503, "photo_storage_unavailable");
  return {
    generation: value.generation,
    size: Number(value.size),
    contentType: "image/jpeg",
    inputSha256: custom.inputSha256,
    jpegSha256: custom.jpegSha256,
    width: Number(custom.width),
    height: Number(custom.height),
  };
}

async function boundedBytes(response: Response, limit: number, signal: AbortSignal) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(503, "photo_storage_unavailable");
  }
  if (!response.body) throw new HttpError(503, "photo_storage_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      if (signal.aborted) throw new HttpError(503, "photo_storage_unavailable");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new HttpError(503, "photo_storage_unavailable");
      chunks.push(value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return output;
  } catch {
    throw new HttpError(503, "photo_storage_unavailable");
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface ExactPhotoMetadata {
  generation: string;
  size: number;
  contentType: "image/jpeg";
  inputSha256: string;
  jpegSha256: string;
  width: number;
  height: number;
}

export class ExactPhotoObjectStore {
  constructor(
    private readonly credential: Pick<Credential, "getAccessToken">,
    private readonly transport: typeof fetch = globalThis.fetch,
  ) {}

  private async token(signal: AbortSignal) {
    return new Promise<Awaited<ReturnType<Credential["getAccessToken"]>>>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => this.credential.getAccessToken()).then(
        (value) => { signal.removeEventListener("abort", abort); resolve(value); },
        (error) => { signal.removeEventListener("abort", abort); reject(error); },
      );
    });
  }

  private async request(
    method: "GET" | "DELETE" | "POST", url: URL, signal?: AbortSignal,
    body?: Uint8Array<ArrayBuffer>, extraHeaders: Record<string, string> = {},
  ) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    try {
      if (requestSignal.aborted) throw new Error("aborted");
      const token = await this.token(requestSignal);
      if (!token.access_token || requestSignal.aborted) throw new Error("credential_unavailable");
      const response = await this.transport(url, {
        method,
        headers: { Authorization: `Bearer ${token.access_token}`, "Cache-Control": "no-store", ...extraHeaders },
        body,
        cache: "no-store",
        redirect: "error",
        signal: requestSignal,
      });
      return { response, requestSignal };
    } catch {
      throw new HttpError(503, "photo_storage_unavailable");
    }
  }

  async read(bucket: string, key: string, exact: string, signal?: AbortSignal) {
    const url = objectUrl(bucket, key);
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", generation(exact));
    const { response, requestSignal } = await this.request("GET", url, signal);
    if (response.status !== 200) throw new HttpError(503, "photo_storage_unavailable");
    return boundedBytes(response, MAX_PHOTO_JPEG_BYTES, requestSignal);
  }

  // A reservation must exist before this method is called. A lost response is
  // outcome-unknown: the caller must inspect this same immutable key, never
  // generate a replacement ID or blindly repeat the paid write.
  async create(
    bucket: string, key: string, jpeg: Uint8Array, inputSha256: string,
    width: number, height: number, signal?: AbortSignal,
  ): Promise<ExactPhotoMetadata> {
    objectUrl(bucket, key); // Validate namespace before acquiring credentials.
    if (jpeg.byteLength < 3 || jpeg.byteLength > MAX_PHOTO_JPEG_BYTES ||
        jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff ||
        !sha256.test(inputSha256) || !Number.isInteger(width) || width < 1 || width > 1600 ||
        !Number.isInteger(height) || height < 1 || height > 1600)
      throw new HttpError(400, "invalid_photo_object");
    const jpegSha256 = createHash("sha256").update(jpeg).digest("hex");
    const metadata = {
      name: key,
      contentType: "image/jpeg",
      cacheControl: "private, no-store",
      metadata: {
        inputSha256, jpegSha256, width: String(width), height: String(height),
      },
    };
    const boundary = `kcalcue-${randomUUID().replaceAll("-", "")}`;
    const body = new Uint8Array(Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.from(jpeg),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]));
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("ifGenerationMatch", "0");
    const { response, requestSignal } = await this.request("POST", url, signal, body, {
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.byteLength),
    });
    if (response.status === 412) throw new HttpError(409, "photo_object_exists");
    if (response.status !== 200) throw new HttpError(503, "photo_storage_unavailable");
    const responseBytes = await boundedBytes(response, metadataLimit, requestSignal);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(responseBytes)); }
    catch { throw new HttpError(503, "photo_storage_unavailable"); }
    const stored = parseMetadata(data, bucket, key);
    if (stored.size !== jpeg.byteLength || stored.inputSha256 !== inputSha256 ||
        stored.jpegSha256 !== jpegSha256 || stored.width !== width || stored.height !== height)
      throw new HttpError(503, "photo_storage_unavailable");
    // Custom metadata echoes caller-supplied strings. Confirm the persisted
    // generation's actual bytes before the registry may stage this object.
    const persisted = await this.read(bucket, key, stored.generation, signal);
    if (persisted.byteLength !== jpeg.byteLength ||
        createHash("sha256").update(persisted).digest("hex") !== jpegSha256)
      throw new HttpError(503, "photo_storage_unavailable");
    return stored;
  }

  // With no generation, this reads latest metadata only for recovery of a
  // known immutable key after an upload outcome is unknown. The caller must
  // match its reservation and hash the exact object bytes before finalizing.
  // A 404 is not proof of absence because a wrong bucket can return it too.
  async metadata(bucket: string, key: string, exact?: string, signal?: AbortSignal): Promise<ExactPhotoMetadata> {
    const url = objectUrl(bucket, key);
    if (exact !== undefined) url.searchParams.set("generation", generation(exact));
    const { response, requestSignal } = await this.request("GET", url, signal);
    if (response.status !== 200) throw new HttpError(503, "photo_storage_unavailable");
    const bytes = await boundedBytes(response, metadataLimit, requestSignal);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new HttpError(503, "photo_storage_unavailable"); }
    return parseMetadata(data, bucket, key, exact);
  }

  // Only delete a confirmed exact generation. A 404 could mean the bucket is
  // misconfigured, so cleanup work stays durable until absence is proven.
  async deleteGeneration(bucket: string, key: string, exact: string, signal?: AbortSignal): Promise<"deleted"> {
    const url = objectUrl(bucket, key);
    url.searchParams.set("generation", generation(exact));
    url.searchParams.set("ifGenerationMatch", exact);
    const { response } = await this.request("DELETE", url, signal);
    if (response.status === 412) throw new HttpError(409, "photo_generation_conflict");
    if (response.status !== 204) throw new HttpError(503, "photo_storage_unavailable");
    return "deleted";
  }
}
