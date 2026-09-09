import { workerSource } from "@/lib/pwa/worker";

// Prerender once per build. Every deployment gets a new worker/cache revision.
export const dynamic = "force-static";
export function GET() {
  return new Response(workerSource(Date.now().toString(36)), { headers: {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache", "Service-Worker-Allowed": "/",
  } });
}
