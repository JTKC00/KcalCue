import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firebase/admin", () => ({
  adminServices: () => ({ auth: { verifyIdToken: verify }, db: {} }),
}));
import { authenticated } from "./auth";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "demo-kcalcue");
  vi.stubEnv("KCALCUE_ALLOWED_EMAILS", "tester@example.com");
  verify
    .mockReset()
    .mockResolvedValue({
      uid: "a",
      email: "tester@example.com",
      email_verified: true,
    });
});
afterEach(() => vi.unstubAllEnvs());
describe("Firebase API authentication", () => {
  it("verifies token revocation and uses only the verified UID", async () => {
    const { user } = await authenticated(
      new Request("http://localhost", {
        headers: { authorization: "Bearer token", "x-user-id": "b" },
      }),
    );
    expect(user.id).toBe("a");
    expect(verify).toHaveBeenCalledWith("token", true);
  });
  it("rejects missing, expired, revoked and unverified credentials", async () => {
    await expect(
      authenticated(new Request("http://localhost")),
    ).rejects.toMatchObject({ status: 401 });
    verify.mockRejectedValueOnce(new Error("revoked"));
    await expect(
      authenticated(
        new Request("http://localhost", {
          headers: { authorization: "Bearer bad" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    verify.mockResolvedValueOnce({
      uid: "a",
      email: "tester@example.com",
      email_verified: false,
    });
    await expect(
      authenticated(
        new Request("http://localhost", {
          headers: { authorization: "Bearer token" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("fails closed when no trial access is configured or the email is not invited", async () => {
    vi.stubEnv("KCALCUE_ALLOWED_EMAILS", "");
    await expect(
      authenticated(
        new Request("http://localhost", {
          headers: { authorization: "Bearer token" },
        }),
      ),
    ).rejects.toMatchObject({ code: "trial_access_required" });
    vi.stubEnv("KCALCUE_ALLOWED_EMAILS", "someone-else@example.com");
    await expect(
      authenticated(
        new Request("http://localhost", {
          headers: { authorization: "Bearer token" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
