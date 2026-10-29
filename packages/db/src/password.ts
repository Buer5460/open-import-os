/**
 * Password hashing.
 *
 * Uses the scrypt KDF from Node's crypto with a per-password random salt, so
 * no plaintext is ever stored and there is no dependency on a native module
 * that might fail to build on the user's machine.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "base64");
  const expected = Buffer.from(parts[2]!, "base64");
  const derived = scryptSync(password.normalize("NFKC"), salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Password policy: minimum length, no silent truncation. */
export function validatePassword(password: string): string | null {
  if (typeof password !== "string") return "password must be a string";
  if (password.length < 10) return "password must be at least 10 characters";
  if (password.length > 200) return "password must be at most 200 characters";
  return null;
}
