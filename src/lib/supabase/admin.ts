import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS and Storage policies
 * entirely, the same way Prisma's DATABASE_URL connection bypasses table
 * RLS as the `postgres` role (see the enable_row_level_security
 * migration's comments).
 *
 * ONLY use this for the CAC document Storage bucket (upload in
 * /api/sender-id/request, signed-URL reads in
 * /api/admin/sender-id/[id]/cac-document). Never import this into
 * anything that runs in — or ships to — the browser: unlike
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY is a full
 * bypass credential, not a public key. This file has no "use client" and
 * isn't imported by any client component, so it never enters the browser
 * bundle as long as that stays true.
 *
 * Not memoized/module-level like other clients in this codebase, since
 * this is only called from a couple of low-traffic admin/upload routes —
 * not worth the complexity of a singleton for this usage pattern.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — required for CAC document storage access."
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
