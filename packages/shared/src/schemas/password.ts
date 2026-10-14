import { z } from "zod";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

// Only entries that would otherwise pass the length check are worth listing,
// so everything here is 12+ characters once lower-cased and stripped of
// anything that isn't a letter or digit.
const COMMON_PASSWORDS = new Set([
  "password1234",
  "password12345",
  "password123456",
  "passw0rd1234",
  "passwordpassword",
  "1234567890",
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456789123456789",
  "111111111111",
  "000000000000",
  "123123123123",
  "123412341234",
  "qwertyuiop12",
  "qwertyuiopas",
  "qwertyuiopasdf",
  "qwertyuiopasdfghjkl",
  "qwertyuiop123",
  "qwertyqwerty12",
  "qwerty123456",
  "qwerty1234567",
  "asdfghjkl123",
  "asdfghjklqwerty",
  "zxcvbnm12345",
  "1q2w3e4r5t6y",
  "1q2w3e4r5t6y7u",
  "1qaz2wsx3edc",
  "1qaz2wsx3edc4rfv",
  "q1w2e3r4t5y6",
  "qazwsxedcrfv",
  "abcdefghijkl",
  "abcdefghijklmnop",
  "abcd12345678",
  "abc123abc123",
  "iloveyou1234",
  "iloveyou12345",
  "iloveyouforever",
  "letmein12345",
  "letmeinletmein",
  "welcome12345",
  "welcome123456",
  "welcomewelcome",
  "administrator",
  "administrator1",
  "administrator123",
  "admin1234567",
  "admin12345678",
  "adminadminadmin",
  "adminpassword",
  "adminpassword1",
  "rootrootroot",
  "rootpassword",
  "changeme1234",
  "changeme12345",
  "changemechangeme",
  "changethispassword",
  "defaultpassword",
  "mypassword1234",
  "mypassword12345",
  "mysecretpassword",
  "supersecret123",
  "supersecretpassword",
  "secretpassword",
  "secretpassword1",
  "trustno1trustno1",
  "monkey123456",
  "dragon123456",
  "master123456",
  "football1234",
  "baseball1234",
  "superman1234",
  "batman123456",
  "sunshine1234",
  "princess1234",
  "starwars1234",
  "pokemon12345",
  "charlie12345",
  "shadow123456",
  "michael12345",
  "jennifer1234",
  "computer1234",
  "internet1234",
  "whatever1234",
  "freedom12345",
  "passwordadmin",
  "testtesttest",
  "testpassword",
  "testpassword1",
  "testing123456",
  "test12345678",
  "user12345678",
  "userpassword",
  "guest1234567",
  "login1234567",
  "hello1234567",
  "helloworld123",
  "helloworldhello",
  "vexlyx12345",
  "vexlyxvexlyx",
  "vexlyxpassword",
  "vexlyxadmin123",
  "hosting12345",
  "hostingpassword",
  "server123456",
  "serverpassword",
  "docker123456",
  "dockerdocker",
  "ubuntu123456",
  "linux1234567",
  "webmaster1234",
  "mailserver123",
  "p4ssw0rd1234",
  "p455w0rd1234",
  "pa55word1234",
  "pa55w0rd1234",
  "october2026",
  "january2026",
  "summer202612",
  "winter202612",
  "spring202612",
]);

// Only swaps that don't disturb digit runs: turning 3 into "e" would turn "1234" into "12e4"
// and hide "password1234". The plain form is checked as well, so trailing digits still match.
const LEET_SUBSTITUTIONS: Record<string, string> = { "@": "a", "$": "s", "0": "o" };

const keepLettersAndDigits = (value: string) => value.replace(/[^a-z0-9]/g, "");

/**
 * Two normalised forms of a password: lower-cased with everything but letters
 * and digits dropped ("P@ssword-1234!" -> "passwor..."), and the same after
 * undoing the usual look-alike swaps so "P@ssw0rd-1234" still matches "password1234".
 */
function normalisedForms(password: string): string[] {
  const lower = password.toLowerCase();
  const decoded = lower.replace(/[@$0]/g, (char) => LEET_SUBSTITUTIONS[char] ?? char);
  return [keepLettersAndDigits(lower), keepLettersAndDigits(decoded)];
}

export function isCommonPassword(password: string): boolean {
  return normalisedForms(password).some(
    // The pattern is one to three characters repeated over and over, e.g. "aaaaaaaaaaaa" or "abcabcabcabc".
    (form) => COMMON_PASSWORDS.has(form) || /^(.{1,3})\1+$/.test(form),
  );
}

/**
 * Policy for choosing a new password (register, change, reset, sub-account
 * creation). Length and a blocklist rather than composition rules, per NIST
 * SP 800-63B. Never applied at login, so existing shorter passwords keep working
 * until their owner changes them.
 */
export const PasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  .refine((value) => !isCommonPassword(value), {
    message: "That password is too common. Choose something less guessable.",
  });
