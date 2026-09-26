export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the byte limit");
    this.name = "RequestBodyTooLargeError";
  }
}

/** Read a body only up to its byte cap, before JSON or multipart parsing. */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let bytes = new Uint8Array(0);
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - byteLength)
        throw new RequestBodyTooLargeError();
      const requiredLength = byteLength + value.byteLength;
      if (requiredLength > bytes.byteLength) {
        const capacity = Math.min(
          maxBytes,
          Math.max(requiredLength, bytes.byteLength * 2),
        );
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, byteLength));
        bytes = expanded;
      }
      // Own the bytes before another read lets the source reuse its chunk buffer.
      bytes.set(value, byteLength);
      byteLength = requiredLength;
    }
  } catch (error) {
    // Start cancellation without letting a slow or failed source prevent rejection.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return bytes.subarray(0, byteLength);
}
