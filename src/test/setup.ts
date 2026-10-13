import "@testing-library/jest-dom/vitest";

// Node 26 exposes a localStorage getter even without a storage file. Vitest may
// leave that getter in place instead of jsdom's per-window browser storage.
// Vitest aliases window to globalThis; use its actual jsdom instance instead.
const browser = (globalThis as typeof globalThis & { jsdom?: { window: Window } }).jsdom?.window;
if (browser) {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true, writable: true, value: browser[name],
    });
  }
}

// jsdom's Blob has no stream(). Undici's Response reads stream() when a test
// builds `new Response(new Blob(...))`. Node's own Blob already has it.
const RuntimeBlob = globalThis.Blob;
if (RuntimeBlob && typeof RuntimeBlob.prototype.stream !== "function") {
  Object.defineProperty(RuntimeBlob.prototype, "stream", {
    configurable: true,
    writable: true,
    value(this: Blob) {
      return new ReadableStream({
        start: (controller) => {
          void this.arrayBuffer().then((buffer) => {
            controller.enqueue(new Uint8Array(buffer));
            controller.close();
          }, (error: unknown) => controller.error(error));
        },
      });
    },
  });
}
