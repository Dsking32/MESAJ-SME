import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

/**
 * Single source of truth for "is the current request an authenticated
 * ADMIN". Previously this exact five-line block (get Supabase user -> look
 * up the User row -> check role === "ADMIN") was copy-pasted independently
 * into every admin API route and every /admin page — 15 separate copies.
 * That's not just noisy, it's a real risk: a new admin route can ship
 * without the check and nothing catches it until it matters. Now there's
 * exactly one place that decides who's an admin.
 */
async function resolveAdmin(): Promise<{
  authUser: { id: string; email?: string } | null;
  admin: User | null;
}> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) return { authUser: null, admin: null };

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  return { authUser, admin: user?.role === "ADMIN" ? user : null };
}

export type AdminAuthResult = { ok: true; admin: User } | { ok: false; response: NextResponse };

/**
 * For API route handlers (route.ts). Route handlers must return a Response
 * rather than redirect, so this returns a discriminated result instead of
 * throwing — callers do:
 *
 *   const auth = await requireAdminApi();
 *   if (!auth.ok) return auth.response;
 *   const { admin } = auth;
 */
export async function requireAdminApi(): Promise<AdminAuthResult> {
  const { admin } = await resolveAdmin();
  if (!admin) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Admin access required" }, { status: 403 }),
    };
  }
  return { ok: true, admin };
}

/**
 * For server-component pages under /admin. Redirects rather than returning
 * a result, so a page just calls it and keeps going:
 *
 *   const { admin, authUser } = await requireAdminPage();
 *
 * This is also called unconditionally from src/app/admin/layout.tsx, which
 * wraps every route under /admin — so even a page that forgets to call this
 * itself is still blocked. The layout call is the real security boundary;
 * the per-page call is just how a page gets the `admin`/`authUser` values
 * it needs to render (e.g. the signed-in email, or admin.id to exclude
 * self-demotion in the users list).
 */
export async function requireAdminPage(): Promise<{
  admin: User;
  authUser: { id: string; email?: string };
}> {
  const { authUser, admin } = await resolveAdmin();
  if (!authUser) redirect("/login");
  if (!admin) redirect("/dashboard");
  return { admin, authUser };
}
