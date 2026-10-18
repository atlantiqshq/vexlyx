"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { useTwoFactor } from "@/hooks/useTwoFactor";
import { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";

type DialogMode = "setup" | "codes" | "disable" | null;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export function TwoFactorCard() {
  const { user, refetch } = useAuth();
  const { setup, confirm, disable } = useTwoFactor();

  const [mode, setMode] = useState<DialogMode>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [qrDataUrl, setQrDataUrl] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [verifyCode, setVerifyCode] = useState("");

  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  const [password, setPassword] = useState("");
  const [codeOrRecovery, setCodeOrRecovery] = useState("");

  const enabled = user?.totpEnabled ?? false;

  const closeDialog = () => {
    if (isBusy) return;
    setMode(null);
    setFormError(null);
    setVerifyCode("");
    setPassword("");
    setCodeOrRecovery("");
    setQrDataUrl("");
    setManualKey("");
    setCopiedKey(false);
  };

  const handleStartSetup = async () => {
    setIsBusy(true);
    setFormError(null);
    try {
      const data = await setup();
      setQrDataUrl(data.qrDataUrl);
      setManualKey(data.manualKey);
      setVerifyCode("");
      setMode("setup");
    } catch (err) {
      const message = errorMessage(err, "Failed to start 2FA setup");
      setFormError(message);
      toast.error(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleConfirmSetup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(verifyCode)) {
      setFormError("Code must be 6 digits");
      return;
    }
    setIsBusy(true);
    setFormError(null);
    try {
      const data = await confirm(verifyCode);
      setRecoveryCodes(data.recoveryCodes);
      setCopiedCodes(false);
      setMode("codes");
      await refetch();
    } catch (err) {
      const message = errorMessage(err, "Invalid code");
      setFormError(message);
      toast.error(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisable = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (codeOrRecovery.trim().length < 6) {
      setFormError("Enter your 6-digit code or a recovery code");
      return;
    }
    setIsBusy(true);
    setFormError(null);
    try {
      await disable(password, codeOrRecovery.trim());
      toast.success("Two-factor authentication disabled");
      setMode(null);
      setPassword("");
      setCodeOrRecovery("");
      await refetch();
    } catch (err) {
      const message = errorMessage(err, "Failed to disable 2FA");
      setFormError(message);
      toast.error(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDismissCodes = () => {
    setMode(null);
    setRecoveryCodes([]);
    setQrDataUrl("");
    setManualKey("");
    setVerifyCode("");
  };

  const copyText = async (text: string, onCopied: () => void) => {
    try {
      await navigator.clipboard.writeText(text);
      onCopied();
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Two-Factor Authentication
            </CardTitle>
            <CardDescription>
              Add an authenticator-app code on top of your password at sign-in.
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className={cn(
              enabled
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-slate-500/20 bg-slate-500/10 text-muted-foreground",
            )}
          >
            {enabled ? "Enabled" : "Not enabled"}
          </Badge>
        </CardHeader>
        <CardContent>
          {enabled ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Your account requires an authenticator code or recovery code at sign-in.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFormError(null);
                  setMode("disable");
                }}
              >
                Disable 2FA
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Protect your account with a time-based one-time code from any authenticator app.
              </p>
              <Button size="sm" onClick={() => void handleStartSetup()} disabled={isBusy}>
                {isBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Set up 2FA
              </Button>
            </div>
          )}
          {formError && !mode && (
            <p className="mt-3 text-sm text-destructive">{formError}</p>
          )}
        </CardContent>
      </Card>

      {/* Setup: QR + manual key + 6-digit verify */}
      <Dialog open={mode === "setup"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set up authenticator app</DialogTitle>
            <DialogDescription>
              Scan the code with your authenticator app, then enter the 6-digit code to
              confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {qrDataUrl && (
              <div className="flex justify-center rounded-lg border border-border bg-white p-4">
                <img src={qrDataUrl} alt="2FA setup QR code" className="h-48 w-48" />
              </div>
            )}
            {manualKey && (
              <div className="space-y-1.5">
                <Label>Manual key</Label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
                    {manualKey}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(manualKey, () => setCopiedKey(true))}
                  >
                    {copiedKey ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            )}
            <form onSubmit={(e) => void handleConfirmSetup(e)} className="space-y-3">
              {formError && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {formError}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="2fa-verify-code">6-digit code</Label>
                <Input
                  id="2fa-verify-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ""))}
                  disabled={isBusy}
                  required
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={closeDialog}
                  disabled={isBusy}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={isBusy}>
                  {isBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Verify &amp; enable
                </Button>
              </DialogFooter>
            </form>
          </div>
        </DialogContent>
      </Dialog>

      {/* Recovery codes, shown exactly once */}
      <Dialog open={mode === "codes"} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save your recovery codes</DialogTitle>
            <DialogDescription>
              Each code works once if you lose your authenticator. They will never be
              shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-1.5 rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm sm:grid-cols-2">
              {recoveryCodes.map((code) => (
                <span key={code} className="px-1">
                  {code}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void copyText(recoveryCodes.join("\n"), () => setCopiedCodes(true))
                }
              >
                {copiedCodes ? (
                  <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                )}
                Copy all
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" onClick={handleDismissCodes}>
              I saved these
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable: password + code confirm */}
      <Dialog open={mode === "disable"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disable two-factor authentication?</DialogTitle>
            <DialogDescription>
              Your account will be protected by password alone. Confirm with your
              password and a current authenticator or recovery code.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleDisable(e)} className="space-y-3">
            {formError && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="2fa-disable-password">Password</Label>
              <Input
                id="2fa-disable-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isBusy}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="2fa-disable-code">Authenticator or recovery code</Label>
              <Input
                id="2fa-disable-code"
                autoComplete="one-time-code"
                maxLength={12}
                value={codeOrRecovery}
                onChange={(e) => setCodeOrRecovery(e.target.value)}
                disabled={isBusy}
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={closeDialog}
                disabled={isBusy}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="sm" disabled={isBusy}>
                {isBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Disable 2FA
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
