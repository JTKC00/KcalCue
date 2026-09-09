import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut,
} from "firebase/auth";

export function cloudConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  );
}
export function browserFirebase() {
  if (!cloudConfigured()) return null;
  return getApps().length
    ? getApp()
    : initializeApp({
        apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
      });
}
export function firebaseAuth() {
  const app = browserFirebase();
  return app ? getAuth(app) : null;
}
export { onAuthStateChanged, signOut };
function clearLogoutMarker(uid: string) {
  if (localStorage.getItem("kcalcue-logout")?.split(":")[0] === uid)
    localStorage.removeItem("kcalcue-logout");
}
export async function googleLogin() {
  const auth = firebaseAuth();
  if (!auth) throw new Error("cloud_unavailable");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  clearLogoutMarker(result.user.uid);
  return result;
}
export function hasEmailLink() {
  const auth = firebaseAuth();
  return !!auth && isSignInWithEmailLink(auth, location.href);
}
export async function sendEmailLink(email: string) {
  const auth = firebaseAuth();
  if (!auth) throw new Error("cloud_unavailable");
  await sendSignInLinkToEmail(auth, email, {
    url: `${location.origin}/`,
    handleCodeInApp: true,
  });
  localStorage.setItem("kcalcue-login-email", email);
}
export async function completeEmailLink(email: string) {
  const auth = firebaseAuth();
  if (!auth || !hasEmailLink()) throw new Error("invalid_link");
  const result = await signInWithEmailLink(auth, email, location.href);
  clearLogoutMarker(result.user.uid);
  localStorage.removeItem("kcalcue-login-email");
  history.replaceState(null, "", "/#today");
}
export async function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  expectedUid?: string,
) {
  const auth = firebaseAuth();
  await auth?.authStateReady();
  const headers = new Headers(init.headers);
  const user = auth?.currentUser;
  if (expectedUid && user?.uid !== expectedUid)
    throw new Error("account_changed");
  if (user) headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
  if (expectedUid && auth?.currentUser?.uid !== expectedUid)
    throw new Error("account_changed");
  return fetch(input, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
}
