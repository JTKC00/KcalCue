/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANALYZE_RATE_LIMIT,
  NUTRITION_RATE_LIMIT,
  clearRateLimitStore,
  clientIpFromHeaders,
  consumeRateLimit,
} from "./rate-limit";

describe("clientIpFromHeaders", () => {
  it("uses the left-most x-forwarded-for address", () => {
    const headers = new Headers({
      "x-forwarded-for": " 203.0.113.10, 10.0.0.1 ",
      "x-real-ip": "10.1.1.1",
    });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.10");
  });

  it("falls back to x-real-ip and then unknown", () => {
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe(
      "198.51.100.2",
    );
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });

  it("ignores a blank spoofed forwarded list and uses the next source", () => {
    const headers = new Headers({
      "x-forwarded-for": " , , ",
      "x-real-ip": "192.0.2.8",
    });
    expect(clientIpFromHeaders(headers)).toBe("192.0.2.8");
  });
});

describe("consumeRateLimit", () => {
  afterEach(() => {
    clearRateLimitStore();
    vi.useRealTimers();
  });

  it("allows up to the limit and then denies in the same window", () => {
    for (let index = 0; index < ANALYZE_RATE_LIMIT.limit; index += 1) {
      expect(consumeRateLimit("analyze:203.0.113.10", ANALYZE_RATE_LIMIT).allowed).toBe(
        true,
      );
    }

    expect(consumeRateLimit("analyze:203.0.113.10", ANALYZE_RATE_LIMIT)).toEqual({
      allowed: false,
      remaining: 0,
    });
  });

  it("keeps analyze and nutrition buckets independent", () => {
    for (let index = 0; index < ANALYZE_RATE_LIMIT.limit; index += 1) {
      consumeRateLimit("analyze:203.0.113.10", ANALYZE_RATE_LIMIT);
    }

    expect(consumeRateLimit("analyze:203.0.113.10", ANALYZE_RATE_LIMIT).allowed).toBe(
      false,
    );
    expect(consumeRateLimit("nutrition:203.0.113.10", NUTRITION_RATE_LIMIT).allowed).toBe(
      true,
    );
  });

  it("refills a token after the window portion elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));

    for (let index = 0; index < ANALYZE_RATE_LIMIT.limit; index += 1) {
      consumeRateLimit("analyze:test", ANALYZE_RATE_LIMIT);
    }
    expect(consumeRateLimit("analyze:test", ANALYZE_RATE_LIMIT).allowed).toBe(false);

    vi.setSystemTime(new Date("2026-09-08T00:00:13Z"));
    expect(consumeRateLimit("analyze:test", ANALYZE_RATE_LIMIT).allowed).toBe(true);
  });
});
