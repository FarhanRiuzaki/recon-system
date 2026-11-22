"use client";

import { useState } from "react";
import { Checkbox, Field, InfoTip, Panel, StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { PasswordInput } from "@starterkit/ui/ui/password-input";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { ConnectorDetailDto, EnvironmentSettings, TokenCheckDto } from "@starterkit/shared/contracts/integrations";
import { type Environment, ENVIRONMENT_LABEL } from "@starterkit/shared/integrations";
import { api, errorText } from "@/lib/client/api";

// One environment of a connector (DEC-053): its address and ids (in the version), its credentials (apart, encrypted:
// Set / Not set, Replace) and Get token, which asks the bank for a token with them.

type SecretKey = "clientId" | "clientSecret" | "publicKey" | "caBundle";
const SECRET_LABEL: Record<SecretKey, string> = { clientId: "Client ID", clientSecret: "Client secret", publicKey: "Bank public key", caBundle: "CA bundle (optional)" };

function ReplaceDialog({ id, env, what, onDone, onClose }: { id: string; env: Environment; what: SecretKey; onDone: (d: ConnectorDetailDto) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pem = what === "publicKey" || what === "caBundle";
  async function save() {
    if (!value.trim()) { setError(`Enter the ${SECRET_LABEL[what].toLowerCase()}.`); return; }
    setBusy(true); setError(null);
    try {
      onDone(await api<ConnectorDetailDto>(`/api/integrations/connectors/${encodeURIComponent(id)}/secrets`, { method: "PUT", body: JSON.stringify({ environment: env, [what]: value.trim() }) }));
    } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top">
        <DialogHeader>
          <DialogTitle>Replace {SECRET_LABEL[what].toLowerCase()} · {ENVIRONMENT_LABEL[env]}</DialogTitle>
          <DialogDescription>It is stored encrypted and never shown again. Calls use it from now on.</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <Field id="secret-value" label={SECRET_LABEL[what]} required error={error}>
          {pem
            ? <Textarea id="secret-value" rows={6} value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" placeholder="-----BEGIN PUBLIC KEY-----" disabled={busy} />
            : what === "clientSecret"
              ? <PasswordInput id="secret-value" value={value} autoComplete="off" onChange={(e) => setValue(e.target.value)} disabled={busy} />
              : <Input id="secret-value" value={value} autoComplete="off" onChange={(e) => setValue(e.target.value)} disabled={busy} />}
        </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => void save()} disabled={busy} aria-busy={busy || undefined}>
            {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Replace {SECRET_LABEL[what].toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EnvironmentCard({ c, env, settings, onSettings, editing, canEdit, active, onDetail }: {
  c: ConnectorDetailDto; env: Environment; settings: EnvironmentSettings; onSettings: (s: EnvironmentSettings) => void; editing: boolean; canEdit: boolean; active: boolean;
  onDetail: (d: ConnectorDetailDto) => void;
}) {
  const [replace, setReplace] = useState<SecretKey | null>(null);
  const [check, setCheck] = useState<{ busy: boolean; r: TokenCheckDto | { error: string } | null }>({ busy: false, r: null });
  const id = (k: string) => `env-${env}-${k}`;
  async function getToken() {
    setCheck({ busy: true, r: null });
    try {
      setCheck({ busy: false, r: await api<TokenCheckDto>(`/api/integrations/connectors/${encodeURIComponent(c.id)}/token-check`, { method: "POST", body: JSON.stringify({ environment: env }) }) });
    } catch (e) { setCheck({ busy: false, r: { error: errorText(e) } }); }
  }
  const set = (k: keyof EnvironmentSettings, v: string) => onSettings({ ...settings, [k]: v });
  return (
    <Panel title={ENVIRONMENT_LABEL[env]} actions={active ? <StatusChip health="healthy" label="Active" /> : undefined}>
      <div className="grid gap-section">
        <div className="grid gap-4 md:grid-cols-2">
          <Field id={id("url")} label="Address">
            <Input id={id("url")} value={settings.baseUrl} disabled={!editing} placeholder="https://openapi.bank.local:15000" className="font-mono" onChange={(e) => set("baseUrl", e.target.value)} />
          </Field>
          <Field id={id("host")} label="Host header">
            <Input id={id("host")} value={settings.host} disabled={!editing} className="font-mono" onChange={(e) => set("host", e.target.value)} />
          </Field>
          <Field id={id("partner")} label="Partner ID">
            <Input id={id("partner")} value={settings.partnerId} disabled={!editing} className="font-mono" onChange={(e) => set("partnerId", e.target.value)} />
          </Field>
          <Field id={id("channel")} label="Channel ID">
            <Input id={id("channel")} value={settings.channelId} disabled={!editing} className="font-mono" onChange={(e) => set("channelId", e.target.value)} />
          </Field>
        </div>
        <span className="flex items-center gap-2">
          <Checkbox id={id("tls")} label="Check the bank's certificate" checked={!!settings.verifyTls} readOnly={!editing} onToggle={() => onSettings({ ...settings, verifyTls: !settings.verifyTls })} />
          <label htmlFor={id("tls")} className="text-body-sm text-fg">Check the bank&apos;s certificate</label>
          <InfoTip label="About the certificate check" title="Certificate check">
            Off by default: the bank&apos;s internal endpoints carry certificates no client checks. The request and the answer stay encrypted either way. On: the CA bundle, else the server&apos;s trusted certificates, must accept it.
          </InfoTip>
        </span>
        <ul className="grid divide-y divide-line" aria-label={`${ENVIRONMENT_LABEL[env]} credentials`}>
          {(Object.keys(SECRET_LABEL) as SecretKey[]).map((k) => (
            <li key={k} className="flex items-center justify-between gap-3 py-2">
              <span className="text-body-sm text-fg">{SECRET_LABEL[k]}</span>
              <span className="flex items-center gap-2">
                <StatusChip health={c.secrets[env][k] ? "healthy" : "stopped"} label={c.secrets[env][k] ? "Set" : k === "caBundle" ? (settings.verifyTls ? "Server's certificates" : "Not used") : "Not set"} />
                {canEdit && <Button type="button" variant="ghost" size="sm" onClick={() => setReplace(k)}>Replace</Button>}
              </span>
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => void getToken()} disabled={check.busy} aria-busy={check.busy || undefined}>
              {check.busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Get token
            </Button>
            <span role="status" className="text-body-sm">
              {check.r && ("error" in check.r ? <span className="text-down-ink">{check.r.error}</span>
                : <span className={check.r.ok ? "text-healthy-ink" : "text-down-ink"}>{check.r.message}</span>)}
            </span>
          </div>
        )}
      </div>
      {replace && <ReplaceDialog id={c.id} env={env} what={replace} onClose={() => setReplace(null)} onDone={(d) => { setReplace(null); onDetail(d); }} />}
    </Panel>
  );
}
