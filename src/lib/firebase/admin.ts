import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export function adminServices() {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("Firebase project not configured");
  const app =
    getApps().find((app) => app.name === "kcalcue-server") ??
    initializeApp(
      {
        projectId,
        credential:
          process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
          process.env.FIREBASE_ADMIN_PRIVATE_KEY
            ? cert({
                projectId,
                clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(
                  /\\n/g,
                  "\n",
                ),
              })
            : applicationDefault(),
      },
      "kcalcue-server",
    );
  return { auth: getAuth(app), db: getFirestore(app) };
}
export function accountPath(uid: string) {
  return `kcalcueUsers/${uid}`;
}
