import { describe, expect, it } from "vitest";
import {
  ChangePasswordSchema,
  CreateSubAccountSchema,
  MIN_PASSWORD_LENGTH,
  PasswordSchema,
  RegisterSchema,
  ResetPasswordSchema,
  isCommonPassword,
} from "@vexlyx/shared";

const GOOD = "correct horse battery staple";

describe("password policy", () => {
  it("requires at least 12 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(PasswordSchema.safeParse("a1".repeat(5) + "b").success).toBe(false);
    expect(PasswordSchema.safeParse("elevenchars").success).toBe(false);
    expect(PasswordSchema.safeParse("twelve-chars!").success).toBe(true);
    expect(PasswordSchema.safeParse(GOOD).success).toBe(true);
  });

  it("caps the length so hashing can't be used to burn CPU", () => {
    expect(PasswordSchema.safeParse(Array.from({ length: 128 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26)) + (i % 3 === 0 ? "" : "")).join("") + "").success).toBe(true);
    expect(PasswordSchema.safeParse("a1b2".repeat(32) + "zq9").success).toBe(false);
  });

  it("uses no composition rules: a long all-lowercase passphrase is fine", () => {
    expect(PasswordSchema.safeParse("purplemonkeydishwasher").success).toBe(true);
  });

  it.each([
    "password1234",
    "Password1234!",
    "P@ssw0rd-1234",
    "p@$$w0rd1234",
    "QWERTYUIOP12",
    "1q2w3e4r5t6y",
    "changeme1234",
    "aaaaaaaaaaaa",
    "abcabcabcabc",
    "123456789012",
  ])("rejects the common password %j", (password) => {
    const result = PasswordSchema.safeParse(password);
    expect(result.success).toBe(false);
    expect(isCommonPassword(password)).toBe(true);
  });

  it("does not flag ordinary passwords as common", () => {
    for (const fine of [GOOD, "purplemonkeydishwasher", "twelve-chars!", "Tr0ub4dor&3-horse", "mP9#vLq2xZ!k"]) {
      expect(isCommonPassword(fine), fine).toBe(false);
    }
  });

  it("explains why a common password was rejected", () => {
    const result = PasswordSchema.safeParse("password1234");
    expect(result.error?.issues[0]?.message).toMatch(/too common/i);
  });

  it("applies everywhere a new password is chosen", () => {
    const weak = "password1234";
    expect(RegisterSchema.safeParse({ email: "a@example.com", name: "A", password: weak, confirmPassword: weak }).success).toBe(false);
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "old", newPassword: weak, confirmNewPassword: weak }).success,
    ).toBe(false);
    expect(ResetPasswordSchema.safeParse({ token: "a".repeat(64), newPassword: weak }).success).toBe(false);
    expect(CreateSubAccountSchema.safeParse({ email: "a@example.com", name: "A", password: weak }).success).toBe(false);

    expect(ResetPasswordSchema.safeParse({ token: "a".repeat(64), newPassword: GOOD }).success).toBe(true);
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "old", newPassword: GOOD, confirmNewPassword: GOOD }).success,
    ).toBe(true);
  });
});
