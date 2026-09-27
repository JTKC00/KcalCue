export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the byte limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyTimeoutError extends Error {
  constructor() {
    super("Request body read timed out");
    this.name = "RequestBodyTimeoutError";
  }
}

const DEFAULT_BODY_TIMEOUT_MS = 45_000;

/** Read a body only up to its byte cap, before JSON or multipart parsing. */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
  timeoutMs = DEFAULT_BODY_TIMEOUT_MS,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const deadline = AbortSignal.timeout(timeoutMs);
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const onTimeout = () => rejectInterrupted(new RequestBodyTimeoutError());
  const onAbort = () => rejectInterrupted(request.signal.reason ?? new DOMException("Request aborted", "AbortError"));
  deadline.addEventListener("abort", onTimeout, { once: true });
  request.signal.addEventListener("abort", onAbort, { once: true });
  let bytes = new Uint8Array(0);
  let byteLength = 0;
  try {
    request.signal.throwIfAborted();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
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
    deadline.removeEventListener("abort", onTimeout);
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  return bytes.subarray(0, byteLength);
}
