import { redirect } from "next/navigation";
import { authContext } from "@/lib/server/session";
import { SunnyGoWordmark } from "@/components/brand";
import { BRAND } from "@starterkit/shared/brand";
import { AuthBackdrop } from "@/features/auth/auth-backdrop";

/** Public sign-in pages; someone already fully signed in goes to the dashboard. The padding grows to a phone's safe-area insets (viewport-fit=cover). */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await authContext()) redirect("/");
  return (
    <main className="relative isolate flex min-h-svh flex-col overflow-clip bg-sheet px-6 py-8 md:p-8">
      {/* The static landscape first (CSS requests only the active theme's artwork), then the live ledger field over it.
          The field covers the whole page: the headline and the footer note sit on a soft scrim, the form on its card. */}
      <AuthBackdrop />
      <header className="relative mx-auto flex w-full max-w-320 py-5 md:py-10"><SunnyGoWordmark className="w-30.5" /></header>
      {/* The headline and the card sit centred on one line in the height between the header and the footer. */}
      <div className="relative mx-auto grid w-full max-w-308 flex-1 content-center items-center gap-10 py-6 md:grid-cols-2 md:gap-12 md:py-4 xl:gap-24">
        <div className="auth-scrim grid gap-6 max-md:hidden">
          <p className="text-display xl:text-welcome">Every record.<br />One clear match.</p>
          <p className="max-w-100 text-body text-fg-2">Match records across your sources in {BRAND.name}, and follow every unmatch item until it closes.</p>
        </div>
        <div className="flex min-w-0 justify-center md:justify-end xl:pr-10">{children}</div>
      </div>
      <footer className="relative mx-auto w-full max-w-320 pt-8 text-caption text-fg-3"><span className="auth-scrim">{BRAND.name}</span></footer>
    </main>
  );
}
