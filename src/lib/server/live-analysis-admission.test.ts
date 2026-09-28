/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveAnalysisAdmission, createUserWorkAdmission } from "./live-analysis-admission";
import { ANALYZE_RATE_LIMIT, PHOTO_PREPARATION_RATE_LIMIT, clearRateLimitStore, consumeRateLimit } from "./rate-limit";

describe("Live analysis admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    clearRateLimitStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRateLimitStore();
  });

  it("consumes five attempts and refills one token after twelve seconds", () => {
    const acquire = createLiveAnalysisAdmission();
    for (let attempt = 0; attempt < 5; attempt++) {
      const release = acquire("user-a");
      expect(release).toBeTypeOf("function");
      release?.();
    }
    expect(acquire("user-a")).toBeNull();
    vi.advanceTimersByTime(11_999);
    expect(acquire("user-a")).toBeNull();
    vi.advanceTimersByTime(1);
    const release = acquire("user-a");
    expect(release).toBeTypeOf("function");
    release?.();
    expect(acquire("user-a")).toBeNull();
  });

  it("does not charge concurrent rejections, and an old release cannot unlock newer work", () => {
    const acquire = createLiveAnalysisAdmission();
    const firstRelease = acquire("user-a");
    for (let attempt = 0; attempt < 10; attempt++) expect(acquire("user-a")).toBeNull();
    expect(acquire("user-b")).toBeTypeOf("function");
    firstRelease?.();
    const secondRelease = acquire("user-a");
    expect(secondRelease).toBeTypeOf("function");
    firstRelease?.();
    expect(acquire("user-a")).toBeNull();
    secondRelease?.();
    for (let attempt = 0; attempt < 3; attempt++) {
      const release = acquire("user-a");
      expect(release).toBeTypeOf("function");
      release?.();
    }
    expect(acquire("user-a")).toBeNull();
  });

  it("fails closed at capacity without evicting quota, then prunes only refilled idle users", () => {
    const acquire = createLiveAnalysisAdmission();
    const busyRelease = acquire("busy-user");
    for (let user = 0; user < 4_999; user++) acquire(`idle-${user}`)?.();
    expect(acquire("new-user")).toBeNull();
    expect(acquire("busy-user")).toBeNull();
    // Existing users still use their remaining quota while the map is full.
    const existingRelease = acquire("idle-0");
    expect(existingRelease).toBeTypeOf("function");
    existingRelease?.();
    vi.advanceTimersByTime(12_000);
    const newRelease = acquire("new-user");
    expect(newRelease).toBeTypeOf("function");
    expect(acquire("busy-user")).toBeNull();
    // idle-0 was not fully refilled and must not receive a new five-token bucket.
    for (let attempt = 0; attempt < 4; attempt++) {
      const release = acquire("idle-0");
      expect(release).toBeTypeOf("function");
      release?.();
    }
    expect(acquire("idle-0")).toBeNull();
    busyRelease?.();
    expect(acquire("busy-user")).toBeTypeOf("function");
  });

  it("keeps all in-flight users at capacity even after their buckets refill", () => {
    const acquire = createLiveAnalysisAdmission();
    const firstRelease = acquire("busy-0");
    for (let user = 1; user < 5_000; user++) expect(acquire(`busy-${user}`)).toBeTypeOf("function");
    vi.advanceTimersByTime(60_000);
    expect(acquire("new-user")).toBeNull();
    expect(acquire("busy-0")).toBeNull();
    firstRelease?.();
    expect(acquire("new-user")).toBeTypeOf("function");
    expect(acquire("busy-1")).toBeNull();
  });

  it("preserves exhausted UID quota despite public IP bucket churn", () => {
    const acquire = createLiveAnalysisAdmission();
    for (let attempt = 0; attempt < 5; attempt++) acquire("user-a")?.();
    for (let ip = 0; ip < 10_000; ip++) consumeRateLimit(`analyze:ip-${ip}`, ANALYZE_RATE_LIMIT);
    expect(acquire("user-a")).toBeNull();
    expect(acquire("user-b")).toBeTypeOf("function");
  });

  it("keeps photo preparation quota separate from public IP bucket eviction", () => {
    const acquire = createUserWorkAdmission(PHOTO_PREPARATION_RATE_LIMIT);
    for (let attempt = 0; attempt < PHOTO_PREPARATION_RATE_LIMIT.limit; attempt++)
      acquire("photo-user")?.();
    for (let ip = 0; ip < 10_000; ip++)
      consumeRateLimit(`analyze:ip-${ip}`, ANALYZE_RATE_LIMIT);
    expect(acquire("photo-user")).toBeNull();
    vi.advanceTimersByTime(4_999);
    expect(acquire("photo-user")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(acquire("photo-user")).toBeTypeOf("function");
  });
});
