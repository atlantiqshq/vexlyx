import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

// The reset token is in the URL fragment; never leak this page's URL onward.
export const metadata: Metadata = {
  title: "Reset Password",
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
