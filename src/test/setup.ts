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
