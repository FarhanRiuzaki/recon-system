"use client";

import { OAUTH_SIGN_IN } from "@starterkit/shared/brand";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { ActionMenu, Avatar, BlockedButton, CategoryChip, InputAffix } from "@starterkit/ui/ds";
import { Button, buttonVariants } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SecureIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { PasswordInput } from "@starterkit/ui/ui/password-input";
import { api, errorText } from "@/lib/client/api";
import { loginIdentifierBadge } from "@starterkit/shared/login-identifier";
import type { LoginResult, TrustedAccountDto } from "@starterkit/shared/contracts/auth";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import type { ConnectionProvider } from "@starterkit/shared/contracts/me";
import { AuthCard, FormError } from "./auth-card";

const PROVIDERS = [{ id: "google", label: "Google" }, { id: "apple", label: "Apple" }] as const;

/** `POST /api/auth/device`: a challenge for a trusted account (`next`), or the password is needed. */
type DeviceAnswer = { next: string; password?: undefined } | { password: true; next?: undefined };

/**
 * On a browser that trusts accounts (DEC-065) the first screen lists them: one press continues to the one-time code,
 * "Use another account" opens the form. Typing a remembered login in the form makes the password optional.
 *
 * Sign in with email or username + password (or LDAP directory password), or a connected Google / Apple account
 * (`providers`: the ones the server has set up; the others stay visible, blocked with the reason). `error`: a
 * message to show first (a provider sign-in that came back failed); its `?error=` is then dropped from the URL.
 */
export function LoginForm({ next, providers, accounts: initialAccounts = [], error: initialError = null }: {
  next: string; providers: Record<ConnectionProvider, boolean>; accounts?: TrustedAccountDto[]; error?: string | null;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState(initialAccounts);
  const [another, setAnother] = useState(false);
  const [forgetting, setForgetting] = useState<TrustedAccountDto | null>(null);
  const [login, setLogin] = useState("");
  const remembered = accounts.some((a) => a.login.toLowerCase() === login.trim().toLowerCase());
  const badge = loginIdentifierBadge(login);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const back = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  // Shown once: the `?error=` goes from the URL (no new history entry), so a reload doesn't repeat it.
  useEffect(() => {
    if (initialError) router.replace(`/login${back}`, { scroll: false });
  }, [initialError, back, router]);

  /** The short flow: this browser's trust instead of the password; false when the password is needed after all. */
  async function viaDevice(who: string): Promise<boolean> {
    const r = await api<DeviceAnswer>("/api/auth/device", { method: "POST", body: JSON.stringify({ login: who, next }) });
    if (r.password) return false;
    router.replace(r.next);
    router.refresh();
    return true;
  }

  async function pick(a: TrustedAccountDto) {
    setBusy(true);
    setError(null);
    try {
      if (await viaDevice(a.login)) return;
      // the trust ended meanwhile: the full flow for this account
      setAccounts(accounts.filter((x) => x.slot !== a.slot));
      setAnother(true);
      setLogin(a.login);
      setError("This device is no longer trusted for this account. Enter your password.");
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (remembered && !password) {
        if (await viaDevice(login)) return;
        setError("This device is no longer trusted for this account. Enter your password.");
        setBusy(false);
        return;
      }
      const r = await api<LoginResult>("/api/auth/login", { method: "POST", body: JSON.stringify({ method: "auto", login, password, next }) });
      router.replace(r.next);
      router.refresh();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const errId = "login-error";
  const described = error ? { "aria-describedby": errId } : {};
  if (accounts.length && !another) {
    return (
      <AuthCard title="Sign in" description="Choose an account this device trusts. You'll enter its one-time code next.">
        <ul className="grid gap-2" aria-label="Accounts on this device">
          {accounts.map((a) => (
            <li key={a.slot} className="flex items-center gap-1 rounded-md border border-line bg-card pr-1">
              <button type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void pick(a)}
                className="press-feedback flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2.5 text-left outline-none hover:bg-tray focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-primary disabled:opacity-60">
                <Avatar name={a.name} seed={a.login} size={32} />
                <span className="grid min-w-0">
                  <span className="truncate text-body text-fg">{a.name}</span>
                  <span className="truncate font-mono text-mono text-fg-3">{a.login}</span>
                </span>
              </button>
              <ActionMenu label={`Actions for ${a.name}`} actions={[{ id: "forget", label: "Forget on this device", destructive: true, onSelect: () => setForgetting(a) }]} />
            </li>
          ))}
        </ul>
        {error && <FormError id={errId} message={error} />}
        <Button type="button" variant="secondary" size="lg" className="h-10 w-full" onClick={() => { setAnother(true); setError(null); }}>Use another account</Button>
        <p className="flex items-center gap-1.5 border-t border-line pt-4 text-caption text-fg-3">
          <Icon icon={SecureIcon} className="size-3.5 shrink-0" />Every sign-in is logged.
        </p>
        {forgetting && <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setForgetting(null); }} auditFields={false} reasons={[]}
          title="Forget this account on this device" description={`${forgetting.name} · ${forgetting.login}`}
          impact={["The next sign-in as this account on this browser asks for the password again."]} actionLabel="Forget account" destructive
          onConfirm={async () => {
            await api("/api/auth/device/forget", { method: "POST", body: JSON.stringify({ slot: forgetting!.slot, login: forgetting!.login }) });
            setAccounts(accounts.filter((x) => x.slot !== forgetting!.slot));
          }} />}
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Sign in" description="Use your email, username or NIP and password.">
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor="login" className="text-label text-fg">Email, username or NIP</label>
          <InputAffix id="login" name="login" className="h-10" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required maxLength={254} value={login} onChange={(e) => { setLogin(e.target.value); setError(null); }} suffix={badge ? <CategoryChip key={badge} label={badge} slot="neutral" className="animate-swap" /> : undefined} {...described} />
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-baseline">
            <label htmlFor="password" className="text-label text-fg">Password</label>
            <Link href="/forgot-password" className="ml-auto text-label text-primary-ink underline underline-offset-4 hover:decoration-2">Forgot password?</Link>
          </div>
          {remembered && <span className="text-caption text-fg-3">This device is trusted for this account: leave the password empty to continue with your one-time code.</span>}
          <PasswordInput id="password" className="h-10 pointer-coarse:h-12" autoComplete="current-password" required={!remembered} value={password} onChange={(e) => setPassword(e.target.value)} {...described} />
        </div>
        {error && <FormError id={errId} message={error} />}
        <Button type="submit" size="lg" className="h-10 w-full" disabled={busy} aria-busy={busy || undefined}>
          {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{remembered && !password ? "Continue" : "Sign in"}
        </Button>
      </form>
      {accounts.length > 0 && (
        <Button type="button" variant="link" className="justify-self-start px-0" onClick={() => { setAnother(false); setError(null); }}>Choose a trusted account</Button>
      )}
      {/* sign-in with a provider only where the product offers it (OAUTH_SIGN_IN; recon doesn't) */}
      {OAUTH_SIGN_IN && <div className="grid gap-2">
        <p className="flex items-center gap-3 text-caption text-fg-3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">or</p>
        {PROVIDERS.map((p) => (providers[p.id]
          ? <a key={p.id} href={`/api/auth/oauth/${p.id}${back}`} className={buttonVariants({ variant: "secondary", size: "lg", className: "h-10 w-full" })}>
              Continue with {p.label}
            </a>
          : <BlockedButton key={p.id} variant="secondary" size="lg" className="h-10 w-full" wrapClassName="w-full" reason={`${p.label} sign-in isn't set up on this server. Sign in another way.`}>
              Continue with {p.label}
            </BlockedButton>))}
      </div>}
      <p className="flex items-center gap-1.5 border-t border-line pt-4 text-caption text-fg-3">
        <Icon icon={SecureIcon} className="size-3.5 shrink-0" />Every sign-in is logged.
      </p>
    </AuthCard>
  );
}
