import type { MessageKey } from "@/i18n/core";
import type { LucideIcon } from "lucide-react";
import {
  Database,
  HardDrive,
  Languages,
  MousePointerClick,
  Server,
  Sliders,
} from "lucide-react";

export type SettingsSectionId =
  | "interface"
  | "models"
  | "generation"
  | "usage"
  | "toolbar"
  | "data";

export type SettingsSectionDefinition = Readonly<{
  id: SettingsSectionId;
  labelKey: MessageKey;
  icon: LucideIcon;
}>;

export type SettingsPolicyLoad = "loading" | "ready" | "unavailable";

const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = Object.freeze([
  { id: "interface", labelKey: "settings.interface", icon: Languages },
  { id: "models", labelKey: "settings.modelsAndChannels", icon: Server },
  { id: "generation", labelKey: "settings.generationDefaults", icon: Sliders },
  { id: "usage", labelKey: "settings.usage", icon: Database },
  { id: "toolbar", labelKey: "settings.imageTools", icon: MousePointerClick },
  { id: "data", labelKey: "settings.dataAndBackup", icon: HardDrive },
]);

export function settingsSectionsFor(_tenantOwner = false): readonly SettingsSectionDefinition[] {
  return SETTINGS_SECTIONS;
}

export function settingsWorkspacePermissions(tenantOwner: boolean) {
  return {
    importCompleteProject: tenantOwner,
    exportCompleteWorkspace: tenantOwner,
    restoreCompleteWorkspace: tenantOwner,
  } as const;
}

export function personalChannelEditableFor(
  tenantOwner: boolean,
  policyLoad: SettingsPolicyLoad,
  allowCustomChannel: boolean,
): boolean {
  if (tenantOwner) return true;
  return policyLoad === "ready" && allowCustomChannel;
}

export function settingsImportEnabledFor(
  tenantOwner: boolean,
  policyLoad: SettingsPolicyLoad,
): boolean {
  return tenantOwner || policyLoad !== "loading";
}

export function settingsChannelImportLockedFor(
  tenantOwner: boolean,
  policyLoad: SettingsPolicyLoad,
  allowCustomChannel: boolean,
): boolean {
  if (tenantOwner) return false;
  if (policyLoad === "ready") return !allowCustomChannel;
  return true;
}

export function settingsScrollTarget(
  scrollTop: number,
  containerTop: number,
  sectionTop: number,
): number {
  return Math.max(0, scrollTop + sectionTop - containerTop - 16);
}

export function settingsHorizontalScrollTarget(
  scrollLeft: number,
  containerLeft: number,
  containerWidth: number,
  itemLeft: number,
  itemWidth: number,
  maxScrollLeft: number,
): number {
  const centered = scrollLeft + itemLeft - containerLeft - ((containerWidth - itemWidth) / 2);
  return Math.min(maxScrollLeft, Math.max(0, centered));
}