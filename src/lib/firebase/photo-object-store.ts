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

  private async request(method: "GET" | "DELETE", url: URL, signal?: AbortSignal) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    try {
      if (requestSignal.aborted) throw new Error("aborted");
      const token = await this.token(requestSignal);
      if (!token.access_token || requestSignal.aborted) throw new Error("credential_unavailable");
      const response = await this.transport(url, {
        method,
        headers: { Authorization: `Bearer ${token.access_token}`, "Cache-Control": "no-store" },
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
    const sha = /^[a-f0-9]{64}$/;
    const dimension = /^[1-9][0-9]{0,3}$/;
    if (typeof custom.inputSha256 !== "string" || !sha.test(custom.inputSha256) ||
        typeof custom.jpegSha256 !== "string" || !sha.test(custom.jpegSha256) ||
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
