"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { toast } from "sonner";
import { usePasswordReset } from "@/hooks/usePasswordReset";
import { ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const passwordSchema = z
  .object({
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FieldErrors = Partial<Record<"newPassword" | "confirmPassword" | "root", string>>;

export function ResetPasswordForm() {
  const router = useRouter();
  const { resetPassword } = usePasswordReset();
  const [token, setToken] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  // The token travels in the URL fragment so it never reaches server logs or
  // Referer headers. Read it once, then strip it from the address bar and history.
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (fromHash) {
      setToken(fromHash);
      window.history.replaceState(null, "", window.location.pathname);
    }
    setIsReady(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!token) return;
    setErrors({});

    const formData = new FormData(e.currentTarget);
    const parsed = passwordSchema.safeParse({
      newPassword: formData.get("newPassword"),
      confirmPassword: formData.get("confirmPassword"),
    });
    if (!parsed.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[issue.path[0] as keyof FieldErrors] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setIsLoading(true);
    try {
      await resetPassword(token, parsed.data.newPassword);
      toast.success("Password updated. Please sign in.");
      router.push("/login");
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : "An unexpected error occurred";
      setErrors({ root: message });
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const hasNoToken = isReady && !token;

  return (
    <Card className="border-border">
      <CardHeader className="space-y-1 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="text-sm text-muted-foreground">
          You&apos;ll be signed out everywhere and asked to sign in again.
        </p>
      </CardHeader>
      <CardContent>
        {hasNoToken ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              This reset link is missing or incomplete. Request a new one to continue.
            </p>
            <Button asChild className="w-full">
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {errors.root && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errors.root}{" "}
                <Link href="/forgot-password" className="font-medium underline underline-offset-4">
                  Request a new link
                </Link>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                autoFocus
                disabled={isLoading || !isReady}
                aria-invalid={!!errors.newPassword}
              />
              {errors.newPassword && (
                <p className="text-xs text-destructive">{errors.newPassword}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm">Confirm new password</Label>
              <Input
                id="reset-confirm"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                disabled={isLoading || !isReady}
                aria-invalid={!!errors.confirmPassword}
              />
              {errors.confirmPassword && (
                <p className="text-xs text-destructive">{errors.confirmPassword}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={isLoading || !isReady}>
              {isLoading ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
