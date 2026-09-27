/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { createPublicBodyAdmission } from "./public-body-admission";

const settings = {
  maxConcurrent: 2,
  routes: {
    analyze: { limit: 3, windowMs: 60_000 },
    nutrition: { limit: 3, windowMs: 60_000 },
  },
};

describe("public request-body admission", () => {
  it("keeps two shared body slots free of spoofable IP keys and releases each once", () => {
    const acquire = createPublicBodyAdmission(settings);
    const first = acquire("analyze");
    const second = acquire("nutrition");
    expect(first.release).toBeTypeOf("function");
    expect(second.release).toBeTypeOf("function");
    expect(acquire("analyze")).toEqual({ retryAfterSeconds: 5 });

    first.release?.();
    first.release?.();
    const next = acquire("analyze");
    expect(next.release).toBeTypeOf("function");
    next.release?.();
    second.release?.();
  });

  it("retains a fixed route budget independent of caller headers", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
      const acquire = createPublicBodyAdmission(settings);
      for (let attempt = 0; attempt < 3; attempt++) {
        acquire("analyze").release?.();
      }
      expect(acquire("analyze")).toEqual({ retryAfterSeconds: 20 });
      expect(acquire("nutrition").release).toBeTypeOf("function");
      vi.advanceTimersByTime(20_000);
      expect(acquire("analyze").release).toBeTypeOf("function");
    } finally {
      vi.useRealTimers();
    }
  });
});
