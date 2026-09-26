import { describe, expect, it, vi } from "vitest";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "./request-body";

function streamedRequest(chunks: Uint8Array[], headers?: HeadersInit) {
  let next = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (next < chunks.length) controller.enqueue(chunks[next++]);
    else controller.close();
  });
  const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  const request = new Request("http://localhost", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, cancel, pull };
}

describe("readBoundedRequestBody", () => {
  it.each([undefined, "1", "invalid"])(
    "enforces actual bytes with content-length %s and cancels before reading more",
    async (length) => {
      const { request, cancel, pull } = streamedRequest(
        [new Uint8Array(3), new Uint8Array(3), new Uint8Array(100)],
        length === undefined ? undefined : { "content-length": length },
      );

      await expect(readBoundedRequestBody(request, 5)).rejects.toBeInstanceOf(
        RequestBodyTooLargeError,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(pull).toHaveBeenCalledTimes(2);
      expect(request.body?.locked).toBe(false);
    },
  );

  it("accepts exactly the limit across chunks without trusting declared length", async () => {
    const { request, cancel } = streamedRequest(
      [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])],
      { "content-length": "1" },
    );

    expect(await readBoundedRequestBody(request, 5)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(request.body?.locked).toBe(false);
  });

  it("assembles many tiny chunks without allocating the full request allowance", async () => {
    const expected = Uint8Array.from({ length: 16_385 }, (_, index) => index % 251);
    const chunks = Array.from(expected, (byte) => new Uint8Array([byte]));
    const { request } = streamedRequest(chunks);
    const allocations: number[] = [];
    const NativeUint8Array = Uint8Array;
    vi.stubGlobal("Uint8Array", new Proxy(NativeUint8Array, {
      construct(target, args) {
        const allocated = Reflect.construct(target, args) as Uint8Array;
        allocations.push(allocated.byteLength);
        return allocated;
      },
    }));
    let result: Uint8Array;
    try {
      result = await readBoundedRequestBody(request, 11 * 1024 * 1024);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(result).toEqual(expected);
    // A small request should use memory proportional to its data, even when fragmented.
    expect(result.buffer.byteLength).toBeLessThanOrEqual(expected.length * 2);
    expect(allocations.reduce((sum, size) => sum + size, 0)).toBeLessThan(expected.length * 4);
    expect(allocations.length).toBeLessThan(100);
  });

  it("copies each chunk before a source reuses its buffer on the next pull", async () => {
    const reusable = new Uint8Array(2);
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next === 4) {
          controller.close();
          return;
        }
        reusable.set([next, 255 - next]);
        next++;
        controller.enqueue(reusable);
      },
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost", {
      method: "POST", body, duplex: "half",
    } as RequestInit);

    const result = await readBoundedRequestBody(request, 9);

    expect(result).toEqual(new Uint8Array([0, 255, 1, 254, 2, 253, 3, 252]));
    expect(result.buffer.byteLength).toBeLessThanOrEqual(9);
    reusable.fill(0);
    expect(result[7]).toBe(252);
  });

  it("discards empty chunks without retaining them for later processing", async () => {
    let previous: ArrayBuffer | undefined;
    let remaining = 2_000;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (previous) structuredClone(previous, { transfer: [previous] });
        if (remaining-- === 0) {
          controller.close();
          return;
        }
        previous = new ArrayBuffer(0);
        controller.enqueue(new Uint8Array(previous));
      },
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost", {
      method: "POST", body, duplex: "half",
    } as RequestInit);

    const result = await readBoundedRequestBody(request, 11 * 1024 * 1024);

    expect(result).toEqual(new Uint8Array());
    expect(result.buffer.byteLength).toBe(0);
    expect(request.body?.locked).toBe(false);
  });

  it("cancels an oversized declared body before pulling any bytes", async () => {
    const { request, cancel, pull } = streamedRequest([new Uint8Array(10)], {
      "content-length": "10",
    });

    await expect(readBoundedRequestBody(request, 5)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });

  it("preserves a byte limit error when the stream rejects cancellation", async () => {
    const { request, cancel } = streamedRequest([new Uint8Array(6)]);
    cancel.mockRejectedValueOnce(new Error("cancel failed"));

    await expect(readBoundedRequestBody(request, 5)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(request.body?.locked).toBe(false);
  });

  it.each([undefined, "6"])(
    "rejects promptly even if cancellation never settles (content-length %s)",
    async (length) => {
      const { request, cancel } = streamedRequest(
        [new Uint8Array(6)],
        length === undefined ? undefined : { "content-length": length },
      );
      cancel.mockReturnValueOnce(new Promise(() => {}));

      await expect(readBoundedRequestBody(request, 5)).rejects.toBeInstanceOf(
        RequestBodyTooLargeError,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(request.body?.locked).toBe(false);
    },
  );

  it("propagates a failed stream without returning partial data", async () => {
    const failure = new Error("connection interrupted");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(failure);
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    await expect(readBoundedRequestBody(request, 5)).rejects.toBe(failure);
    expect(request.body?.locked).toBe(false);
  });

  it("returns empty bytes for a missing body", async () => {
    expect(
      await readBoundedRequestBody(
        new Request("http://localhost", { method: "POST" }),
        5,
      ),
    ).toEqual(new Uint8Array());
  });
});
