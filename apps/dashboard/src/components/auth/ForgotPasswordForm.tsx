"use client";

import { useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { toast } from "sonner";
import { usePasswordReset } from "@/hooks/usePasswordReset";
import { ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const emailSchema = z.string().email("Invalid email address");

export function ForgotPasswordForm() {
  const { requestReset } = usePasswordReset();
  const [isLoading, setIsLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [isSent, setIsSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setEmailError(null);

    const email = (new FormData(e.currentTarget).get("email") as string).trim();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? "Invalid email address");
      return;
    }

    setIsLoading(true);
    try {
      await requestReset(email);
      setIsSent(true);
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="border-border">
      <CardHeader className="space-y-1 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Forgot your password?</h1>
        <p className="text-sm text-muted-foreground">
          {isSent
            ? "Check your inbox"
            : "Enter your email and we'll send you a link to choose a new one"}
        </p>
      </CardHeader>
      <CardContent>
        {isSent ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              If that email belongs to an account, a reset link is on its way. It works once and
              expires in 30 minutes.
            </p>
            <p className="text-xs text-muted-foreground">
              Admin accounts can&apos;t be reset by email unless your server operator turns that
              on.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="forgot-email">Email</Label>
              <Input
                id="forgot-email"
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                autoFocus
                disabled={isLoading}
                aria-invalid={!!emailError}
              />
              {emailError && <p className="text-xs text-destructive">{emailError}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}
        <div className="mt-4 text-center text-sm">
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
