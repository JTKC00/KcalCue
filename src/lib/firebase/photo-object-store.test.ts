import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { expect, it, vi } from "vitest";
import { ExactPhotoObjectStore } from "./photo-object-store";

const bucket = "private-meal-fixture";
const key = "meal-photos/v1/dXNlci1h/461fe664-d9c7-4fc2-8ea3-c641954838c6/d52f58f7-61f9-41f7-a5f3-e4fa4476ff73.jpg";
const exact = "9007199254740993"; // above Number.MAX_SAFE_INTEGER
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const inputSha256 = "a".repeat(64);
const jpegSha256 = createHash("sha256").update(jpeg).digest("hex");
function storedMetadata(overrides: Record<string, unknown> = {}) {
  return {
    bucket, name: key, generation: exact, size: String(jpeg.byteLength), contentType: "image/jpeg",
    metadata: { inputSha256, jpegSha256, width: "640", height: "480" },
    ...overrides,
  };
}
function adapter(transport: ReturnType<typeof vi.fn>) {
  const credential = { getAccessToken: vi.fn().mockResolvedValue({ access_token: "test-token", expires_in: 3600 }) };
  return { store: new ExactPhotoObjectStore(credential, transport as typeof fetch), credential };
}
function calledUrl(transport: ReturnType<typeof vi.fn>) {
  return new URL(transport.mock.calls[0][0] as URL);
}

it("reads exactly the long generation using the authenticated JSON API without numeric coercion", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const transport = vi.fn().mockResolvedValue(new Response(bytes));
  const { store } = adapter(transport);
  expect(await store.read(bucket, key, exact)).toEqual(bytes);
  const url = calledUrl(transport);
  expect(url.origin).toBe("https://storage.googleapis.com");
  expect(url.pathname).toContain("/meal-photos%2Fv1%2F");
  expect(url.searchParams.get("generation")).toBe(exact);
  expect(url.searchParams.get("alt")).toBe("media");
  const init = transport.mock.calls[0][1] as RequestInit;
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
  expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
});

it("never requests latest bytes when generation is absent or malformed", async () => {
  const transport = vi.fn();
  const { store, credential } = adapter(transport);
  for (const value of ["", "0", "01", "9007199254740993&alt=json", "1.5"]) {
    await expect(store.read(bucket, key, value)).rejects.toMatchObject({ status: 503 });
  }
  expect(transport).not.toHaveBeenCalled();
  expect(credential.getAccessToken).not.toHaveBeenCalled();
});

it("bounds the response even when the server omits Content-Length", async () => {
  const transport = vi.fn().mockResolvedValue(new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  const { store } = adapter(transport);
  await expect(store.read(bucket, key, exact)).rejects.toMatchObject({ status: 503 });
});

it("cancels an oversized declared body and normalizes a stream failure", async () => {
  const cancel = vi.fn();
  const declared = new ReadableStream<Uint8Array>({ cancel });
  const failed = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("raw transport detail")); },
  });
  const transport = vi.fn().mockResolvedValueOnce(new Response(declared, {
    headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
  })).mockResolvedValueOnce(new Response(failed));
  const { store } = adapter(transport);
  await expect(store.read(bucket, key, exact)).rejects.toMatchObject({ status: 503, code: "photo_storage_unavailable" });
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(store.read(bucket, key, exact)).rejects.toMatchObject({ status: 503, code: "photo_storage_unavailable" });
});

it("returns exact metadata as strings and rejects rounded or mismatched metadata", async () => {
  const transport = vi.fn().mockResolvedValueOnce(Response.json({
    bucket, name: key, generation: exact, size: "3", contentType: "image/jpeg",
    metadata: { inputSha256: "a".repeat(64), jpegSha256: "b".repeat(64), width: "640", height: "480" },
  })).mockResolvedValueOnce(Response.json({
    bucket, name: key, generation: Number(exact), size: "3", contentType: "image/jpeg",
  }));
  const { store } = adapter(transport);
  expect(await store.metadata(bucket, key, exact)).toEqual({
    generation: exact, size: 3, contentType: "image/jpeg",
    inputSha256: "a".repeat(64), jpegSha256: "b".repeat(64), width: 640, height: 480,
  });
  expect(calledUrl(transport).searchParams.get("generation")).toBe(exact);
  await expect(store.metadata(bucket, key, exact)).rejects.toMatchObject({ status: 503 });
});

it("deletes only the exact generation and does not treat 404 or 412 as success", async () => {
  const transport = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 412 }));
  const { store } = adapter(transport);
  expect(await store.deleteGeneration(bucket, key, exact)).toBe("deleted");
  await expect(store.deleteGeneration(bucket, key, exact)).rejects.toMatchObject({ status: 503 });
  await expect(store.deleteGeneration(bucket, key, exact)).rejects.toMatchObject({ status: 409 });
  for (const [url] of transport.mock.calls) {
    const query = new URL(url as URL).searchParams;
    expect(query.get("generation")).toBe(exact);
    expect(query.get("ifGenerationMatch")).toBe(exact);
  }
});

it("keeps a missing bucket or malformed recovery metadata as unknown", async () => {
  const transport = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({
      bucket, name: key, generation: exact, size: "3", contentType: "image/jpeg",
      metadata: { inputSha256: "not-a-hash", jpegSha256: "b".repeat(64), width: "640", height: "480" },
    }));
  const { store } = adapter(transport);
  await expect(store.metadata(bucket, key)).rejects.toMatchObject({ status: 503 });
  await expect(store.metadata(bucket, key)).rejects.toMatchObject({ status: 503 });
});

it("does not wait indefinitely for credentials after the caller aborts", async () => {
  const credential = { getAccessToken: vi.fn().mockReturnValue(new Promise(() => {})) };
  const transport = vi.fn();
  const store = new ExactPhotoObjectStore(credential, transport as typeof fetch);
  const controller = new AbortController();
  const pending = store.read(bucket, key, exact, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ status: 503 });
  expect(transport).not.toHaveBeenCalled();
});

it("rejects paths outside the private photo namespace before using credentials", async () => {
  const transport = vi.fn();
  const { store, credential } = adapter(transport);
  await expect(store.deleteGeneration(bucket, "someone-elses-file", exact)).rejects.toMatchObject({ status: 503 });
  await expect(store.read("https://attacker.test", key, exact)).rejects.toMatchObject({ status: 503 });
  expect(transport).not.toHaveBeenCalled();
  expect(credential.getAccessToken).not.toHaveBeenCalled();
});

it("creates one immutable JPEG with a zero-generation precondition and verifiable metadata", async () => {
  const transport = vi.fn().mockResolvedValueOnce(Response.json(storedMetadata()))
    .mockResolvedValueOnce(new Response(jpeg));
  const { store } = adapter(transport);
  expect(await store.create(bucket, key, jpeg, inputSha256, 640, 480)).toEqual({
    generation: exact, size: 4, contentType: "image/jpeg", inputSha256, jpegSha256,
    width: 640, height: 480,
  });
  expect(transport).toHaveBeenCalledTimes(2);
  const url = calledUrl(transport);
  expect(url.pathname).toBe("/upload/storage/v1/b/private-meal-fixture/o");
  expect(url.searchParams.get("uploadType")).toBe("multipart");
  expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
  const init = transport.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe("POST");
  const headers = new Headers(init.headers);
  expect(headers.get("Content-Type")).toMatch(/^multipart\/related; boundary=kcalcue-[a-f0-9]{32}$/);
  const body = Buffer.from(init.body as Uint8Array);
  expect(Number(headers.get("Content-Length"))).toBe(body.byteLength);
  expect(body.includes(Buffer.from(jpeg))).toBe(true);
  expect(body.toString("latin1")).toContain('"cacheControl":"private, no-store"');
  expect(body.toString("latin1")).toContain(`"jpegSha256":"${jpegSha256}"`);
  const readback = new URL(transport.mock.calls[1][0] as URL);
  expect(readback.searchParams.get("generation")).toBe(exact);
  expect(readback.searchParams.get("alt")).toBe("media");
});

it("fails before paid write for invalid JPEG or claimed source hash", async () => {
  const transport = vi.fn();
  const { store, credential } = adapter(transport);
  await expect(store.create(bucket, key, new Uint8Array([1, 2, 3]), inputSha256, 640, 480))
    .rejects.toMatchObject({ status: 400 });
  await expect(store.create(bucket, key, jpeg, "invalid", 640, 480))
    .rejects.toMatchObject({ status: 400 });
  expect(credential.getAccessToken).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it("treats a precondition conflict or malformed successful response as unresolved without retrying", async () => {
  const transport = vi.fn().mockResolvedValueOnce(new Response(null, { status: 412 }))
    .mockResolvedValueOnce(Response.json(storedMetadata({ generation: Number(exact) })));
  const { store } = adapter(transport);
  await expect(store.create(bucket, key, jpeg, inputSha256, 640, 480))
    .rejects.toMatchObject({ status: 409, code: "photo_object_exists" });
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(store.create(bucket, key, jpeg, inputSha256, 640, 480))
    .rejects.toMatchObject({ status: 503, code: "photo_storage_unavailable" });
  expect(transport).toHaveBeenCalledTimes(2);
});

it("does not acknowledge a stored object whose exact-generation bytes differ", async () => {
  const transport = vi.fn().mockResolvedValueOnce(Response.json(storedMetadata()))
    .mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00])));
  const { store } = adapter(transport);
  await expect(store.create(bucket, key, jpeg, inputSha256, 640, 480))
    .rejects.toMatchObject({ status: 503, code: "photo_storage_unavailable" });
  expect(transport).toHaveBeenCalledTimes(2);
});
