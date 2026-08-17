export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export type PasswordPolicyError = "too-short" | "too-long";

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

export function passwordPolicyError(password: string): PasswordPolicyError | null {
  if (password.trim() === "") return "too-short";
  const bytes = passwordByteLength(password);
  if (bytes < PASSWORD_MIN_LENGTH) return "too-short";
  if (bytes > PASSWORD_MAX_LENGTH) return "too-long";
  return null;
}

export function passwordsMatch(password: string, confirmation: string): boolean {
  return password === confirmation;
}
