import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { afterSignIn, signInHref } from "@starterkit/ui/lib/safe-path";
import { TwoFactorForm } from "@/features/auth/two-factor-form";
import { getSession, pendingChallenge } from "@/lib/server/session";

export const metadata: Metadata = { title: "Two-factor authentication" };

/**
 * Only reachable with a pending sign-in (password accepted, second factor due, under 10 minutes old); otherwise back
 * to sign-in. The API's 401 for an expired challenge stays the backstop.
 */
export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  const target = afterSignIn(typeof next === "string" ? next : null);
  const s = await getSession();
  if (!pendingChallenge(s)) redirect(signInHref(target));
  // a device sign-in (DEC-065) already uses this browser's trust: nothing new to trust
  return <TwoFactorForm next={target} offerTrust={!s.device} />;
}
