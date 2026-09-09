// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  complete: vi.fn(),
  popup: vi.fn(),
  link: vi.fn(),
  token: vi.fn(),
  auth: {
    currentUser: null as null | {
      uid: string;
      getIdToken: () => Promise<string>;
    },
    authStateReady: async () => {},
  },
}));
vi.mock("firebase/app", () => ({
  getApps: () => [],
  initializeApp: () => ({}),
}));
vi.mock("firebase/auth", () => ({
  getAuth: () => mocks.auth,
  onAuthStateChanged: vi.fn(),
  signOut: vi.fn(),
  GoogleAuthProvider: class {
    parameters = {};
    setCustomParameters(parameters: object) {
      this.parameters = parameters;
    }
  },
  signInWithPopup: mocks.popup,
  sendSignInLinkToEmail: mocks.send,
  isSignInWithEmailLink: mocks.link,
  signInWithEmailLink: mocks.complete,
}));
import {
  authorizedFetch,
  completeEmailLink,
  googleLogin,
  sendEmailLink,
} from "./client";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "test");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "demo-kcalcue");
  vi.stubEnv(
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "demo-kcalcue.firebaseapp.com",
  );
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "test");
  vi.clearAllMocks();
  localStorage.clear();
  mocks.link.mockReturnValue(true);
  mocks.complete.mockResolvedValue({ user: { uid: "a" } });
  mocks.popup.mockResolvedValue({ user: { uid: "a" } });
  mocks.auth.currentUser = { uid: "a", getIdToken: mocks.token };
  mocks.token.mockResolvedValue("verified-token");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ ok: true })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("Firebase login methods", () => {
  it("sends a same-origin Email link without placing the email in the callback URL", async () => {
    await sendEmailLink("tester@example.com");
    expect(mocks.send).toHaveBeenCalledWith(mocks.auth, "tester@example.com", {
      url: `${location.origin}/`,
      handleCodeInApp: true,
    });
    expect(localStorage.getItem("kcalcue-login-email")).toBe(
      "tester@example.com",
    );
  });
  it("requires a sign-in link, confirms the supplied email and removes callback data after success", async () => {
    localStorage.setItem("kcalcue-login-email", "tester@example.com");
    localStorage.setItem("kcalcue-logout", `a:${Date.now()}`);
    await completeEmailLink("tester@example.com");
    expect(mocks.complete).toHaveBeenCalledWith(
      mocks.auth,
      "tester@example.com",
      expect.any(String),
    );
    expect(localStorage.getItem("kcalcue-login-email")).toBeNull();
    expect(localStorage.getItem("kcalcue-logout")).toBeNull();
    expect(location.search).toBe("");
    mocks.link.mockReturnValue(false);
    await expect(completeEmailLink("tester@example.com")).rejects.toThrow(
      "invalid_link",
    );
  });
  it("offers Google account selection via the Firebase OAuth popup", async () => {
    await googleLogin();
    expect(mocks.popup).toHaveBeenCalledWith(
      mocks.auth,
      expect.objectContaining({ parameters: { prompt: "select_account" } }),
    );
  });
  it("does not send a pending account's request after an account switch during token refresh", async () => {
    mocks.token.mockImplementationOnce(async () => {
      mocks.auth.currentUser = { uid: "b", getIdToken: mocks.token };
      return "a-token";
    });
    await expect(authorizedFetch("/api/meals", {}, "a")).rejects.toThrow(
      "account_changed",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
