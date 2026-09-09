import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
export function cloudConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}
export function browserSupabase() {
  if (!cloudConfigured()) return null;
  client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
  return client;
}
export async function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const session = await browserSupabase()?.auth.getSession();
  const headers = new Headers(init.headers);
  if (session?.data.session)
    headers.set("Authorization", `Bearer ${session.data.session.access_token}`);
  return fetch(input, { ...init, headers });
}
