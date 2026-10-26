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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not trust x-forwarded-for or x-real-ip by default when no proxy hop count is configured", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.10, 10.0.0.1",
      "x-real-ip": "198.51.100.2",
    });
    expect(clientIpFromHeaders(headers)).toBe("unknown");
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe(
      "unknown",
    );
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });

  it("extracts the verified client hop for a configured single-hop or multi-hop proxy chain and ignores spoofed prefixes", () => {
    const singleHop = new Headers({
      "x-forwarded-for": "198.51.100.99, 198.51.100.98, 203.0.113.10",
      "x-real-ip": "10.1.1.1",
      "x-forwarded-proto": "https",
    });
    expect(clientIpFromHeaders(singleHop, { trustedProxyHops: 1 })).toBe("203.0.113.10");

    vi.stubEnv("KCALCUE_TRUSTED_PROXY_HOPS", "2");
    const twoHop = new Headers({
      "x-forwarded-for": "198.51.100.77, 203.0.113.25, 10.0.0.1",
      "x-real-ip": "10.1.1.1",
      "x-forwarded-proto": "https",
    });
    expect(clientIpFromHeaders(twoHop)).toBe("203.0.113.25");
  });

  it("normalizes IPv4-mapped IPv6 and different IPv6 representations to the same canonical address", () => {
    expect(
      clientIpFromHeaders(
        new Headers({ "x-forwarded-for": "::ffff:203.0.113.10" }),
        { trustedProxyHops: 1 },
      ),
    ).toBe("203.0.113.10");

    const expanded = clientIpFromHeaders(
      new Headers({
        "x-forwarded-for": "2001:0DB8:0000:0000:0000:0000:0000:0001, 10.0.0.1",
      }),
      { trustedProxyHops: 2 },
    );
    const compressed = clientIpFromHeaders(
      new Headers({
        "x-forwarded-for": "[2001:db8:0:0::1], 10.0.0.1",
      }),
      { trustedProxyHops: 2 },
    );
    expect(expanded).toBe("2001:db8::1");
    expect(compressed).toBe("2001:db8::1");
  });

  it("rejects malformed headers, unspecified IPs, overly long inputs, and abnormal proxy chains", () => {
    const opts = { trustedProxyHops: 2 };
    // Fewer hops than required by the trusted proxy chain
    expect(
      clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.10" }), opts),
    ).toBe("unknown");
    // Malformed client hop or proxy hop in the trusted suffix
    expect(
      clientIpFromHeaders(new Headers({ "x-forwarded-for": "not-an-ip, 10.0.0.1" }), opts),
    ).toBe("unknown");
    expect(
      clientIpFromHeaders(
        new Headers({ "x-forwarded-for": "203.0.113.10, not-a-proxy" }),
        opts,
      ),
    ).toBe("unknown");
    expect(
      clientIpFromHeaders(new Headers({ "x-forwarded-for": " , , " }), {
        trustedProxyHops: 1,
      }),
    ).toBe("unknown");
    // Unspecified, zoned, port-suffixed, or non-decimal addresses
    for (const invalid of [
      "0.0.0.0",
      "::",
      "::ffff:0.0.0.0",
      "01.02.03.04",
      "203.0.113.10:8080",
      "[2001:db8::1]:8080",
      "fe80::1%eth0",
      "999.0.0.1",
    ]) {
      expect(
        clientIpFromHeaders(new Headers({ "x-forwarded-for": invalid }), {
          trustedProxyHops: 1,
        }),
      ).toBe("unknown");
    }
    // Overly long header or too many hops
    expect(
      clientIpFromHeaders(
        new Headers({ "x-forwarded-for": `${"203.0.113.1, ".repeat(45)}203.0.113.2` }),
        { trustedProxyHops: 1 },
      ),
    ).toBe("unknown");
    expect(
      clientIpFromHeaders(
        new Headers({
          "x-forwarded-for": Array.from({ length: 17 }, (_, i) => `10.0.0.${i + 1}`).join(", "),
        }),
        { trustedProxyHops: 1 },
      ),
    ).toBe("unknown");
    // Invalid x-forwarded-proto or invalid env configuration
    expect(
      clientIpFromHeaders(
        new Headers({
          "x-forwarded-for": "203.0.113.10",
          "x-forwarded-proto": "javascript",
        }),
        { trustedProxyHops: 1 },
      ),
    ).toBe("unknown");
    vi.stubEnv("KCALCUE_TRUSTED_PROXY_HOPS", "invalid");
    expect(
      clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.10" })),
    ).toBe("unknown");
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

  it("preserves exhausted anonymous and verified-UID buckets during IP key churn", () => {
    for (let index = 0; index < ANALYZE_RATE_LIMIT.limit; index += 1) {
      consumeRateLimit("analyze:anonymous", ANALYZE_RATE_LIMIT);
    }
    for (let index = 0; index < NUTRITION_RATE_LIMIT.limit; index += 1) {
      consumeRateLimit("nutrition:uid:user-a", NUTRITION_RATE_LIMIT);
    }

    for (let ip = 0; ip < 10_000; ip += 1) {
      consumeRateLimit(`analyze:ip:198.51.${Math.floor(ip / 256)}.${ip % 256}`, ANALYZE_RATE_LIMIT);
    }

    expect(consumeRateLimit("analyze:anonymous", ANALYZE_RATE_LIMIT).allowed).toBe(false);
    expect(consumeRateLimit("nutrition:uid:user-a", NUTRITION_RATE_LIMIT).allowed).toBe(false);
    expect(consumeRateLimit("nutrition:uid:user-b", NUTRITION_RATE_LIMIT).allowed).toBe(true);
  });
});
