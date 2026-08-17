import type { MessageKey } from "@/i18n/core";
import type { LucideIcon } from "lucide-react";
import {
  BookMarked,
  Cable,
  Coins,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Library,
  ShieldCheck,
  Users,
} from "lucide-react";

export type AdminTab =
  | "quota"
  | "users"
  | "credits"
  | "policy"
  | "channels"
  | "prompts"
  | "library"
  | "storage"
  | "platform"
  | "models";

export type AdminNavGroupId = "tenant" | "platform";

export type AdminNavGroup = Readonly<{
  id: AdminNavGroupId;
  labelKey: MessageKey;
  tabs: readonly AdminTab[];
}>;

export const TENANT_ADMIN_TABS: readonly AdminTab[] = Object.freeze([
  "quota", "users", "credits", "policy", "channels", "prompts", "library", "storage",
]);

export const PLATFORM_ADMIN_TABS: readonly AdminTab[] = Object.freeze(["platform", "models"]);

export const ADMIN_TAB_LABELS: Record<AdminTab, MessageKey> = {
  quota: "admin.tab.quota",
  users: "admin.tab.users",
  credits: "admin.tab.credits",
  policy: "admin.tab.policy",
  models: "admin.tab.models",
  channels: "admin.tab.channels",
  prompts: "admin.tab.prompts",
  library: "admin.tab.library",
  storage: "admin.tab.storage",
  platform: "admin.tab.platform",
};

export const ADMIN_TAB_ICONS: Record<AdminTab, LucideIcon> = {
  quota: Gauge,
  users: Users,
  credits: Coins,
  policy: ShieldCheck,
  models: Cpu,
  channels: Cable,
  prompts: BookMarked,
  library: Library,
  storage: HardDrive,
  platform: Database,
};

export function adminNavGroupsForCapabilities(capabilities: {
  tenantOwner: boolean;
  platformAdmin: boolean;
}): AdminNavGroup[] {
  return [
    ...(capabilities.tenantOwner
      ? [{ id: "tenant" as const, labelKey: "admin.nav.tenant" as const, tabs: TENANT_ADMIN_TABS }]
      : []),
    ...(capabilities.platformAdmin
      ? [{ id: "platform" as const, labelKey: "admin.nav.platform" as const, tabs: PLATFORM_ADMIN_TABS }]
      : []),
  ];
}

export function adminTabsForCapabilities(capabilities: {
  tenantOwner: boolean;
  platformAdmin: boolean;
}): AdminTab[] {
  return adminNavGroupsForCapabilities(capabilities).flatMap((group) => [...group.tabs]);
}
