import { nanoid } from "nanoid";

export function uid(prefix = ""): string {
  return prefix ? `${prefix}_${nanoid(10)}` : nanoid(12);
}

export function nowIso(): string {
  return new Date().toISOString();
}
