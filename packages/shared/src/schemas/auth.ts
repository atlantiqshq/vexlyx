import { z } from "zod";

const emailSchema = z.string().email("Invalid email address");

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters");

export const RegisterSchema = z
  .object({
    email: emailSchema,
    name: z.string().min(1, "Name is required").max(100),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof LoginSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: passwordSchema,
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Passwords do not match",
    path: ["confirmNewPassword"],
  });

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export const TwoFactorChallengeSchema = z.object({
  challengeToken: z.string().min(32),
  code: z.string().regex(/^[0-9a-zA-Z-]{6,12}$/, "Invalid code"),
});

export type TwoFactorChallengeInput = z.infer<typeof TwoFactorChallengeSchema>;

export const VerifyTotpSetupSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export type VerifyTotpSetupInput = z.infer<typeof VerifyTotpSetupSchema>;

export const DisableTwoFactorSchema = z.object({
  password: z.string().min(1, "Password is required"),
  codeOrRecovery: z.string().min(6),
});

export type DisableTwoFactorInput = z.infer<typeof DisableTwoFactorSchema>;

export const ForgotPasswordSchema = z.object({
  email: emailSchema,
});

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(32).max(128),
  newPassword: passwordSchema,
});

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
