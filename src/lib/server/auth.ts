import { adminServices } from "@/lib/firebase/admin";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export async function authenticated(request: Request) {
  if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID)
    throw new HttpError(503, "cloud_unavailable");
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer "))
    throw new HttpError(401, "login_required");
  const services = adminServices();
  let token;
  try {
    token = await services.auth.verifyIdToken(authorization.slice(7), true);
  } catch {
    throw new HttpError(401, "login_required");
  }
  if (!token.email_verified) throw new HttpError(403, "email_unverified");
  const allowed = (process.env.KCALCUE_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (
    !allowed.length ||
    !token.email ||
    !allowed.includes(token.email.toLowerCase())
  )
    throw new HttpError(403, "trial_access_required");
  return { ...services, user: { id: token.uid, email: token.email } };
}
export function apiError(error: unknown) {
  return Response.json(
    {
      error: {
        code: error instanceof HttpError ? error.code : "service_unavailable",
      },
    },
    {
      status: error instanceof HttpError ? error.status : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
