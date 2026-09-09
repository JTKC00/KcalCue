import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { workerSource } from "./worker";

describe("service worker boundaries", () => {
  it("does not activate without a user's update action and ignores private requests", () => {
    const events = new Map<string, (event: unknown) => void>();
    const skipWaiting = vi.fn();
    runInNewContext(workerSource("test"), {
      URL,
      self: {
        location: { origin: "https://kcalcue.test" },
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          events.set(name, handler),
        skipWaiting,
      },
    });
    expect(skipWaiting).not.toHaveBeenCalled();
    events.get("message")!({ data: { type: "unrelated" } });
    expect(skipWaiting).not.toHaveBeenCalled();
    events.get("message")!({ data: { type: "ACTIVATE_UPDATE" } });
    expect(skipWaiting).toHaveBeenCalledOnce();
    for (const [url, options] of [
      ["https://kcalcue.test/api/meals", {}],
      ["https://kcalcue.test/auth", {}],
      ["https://other.test/icon.png", {}],
      [
        "https://kcalcue.test/",
        { headers: { Authorization: "Bearer private" } },
      ],
      ["https://kcalcue.test/", { headers: { RSC: "1" } }],
    ] as const) {
      const respondWith = vi.fn();
      events.get("fetch")!({ request: new Request(url, options), respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });
});
