import type { AssetItem, PromptItem } from "@/types/board";

export type OptionalLocalStateResource =
  | { id: "assets"; value: AssetItem[] }
  | { id: "prompts"; value: PromptItem[] };

export type MigrationCredentialSummary = {
  present: boolean;
  labels: string[];
};

type CredentialSources = {
  apiKeys: Record<string, Record<string, string>>;
  webdavPass: string;
  objectStorageAccessKeyId?: string;
  objectStorageSecretAccessKey?: string;
  objectStorageSessionToken?: string;
};

export function optionalLocalStateResources(
  assets: AssetItem[] | undefined,
  prompts: PromptItem[] | undefined,
): OptionalLocalStateResource[] {
  return [
    ...(assets === undefined ? [] : [{ id: "assets" as const, value: assets }]),
    ...(prompts === undefined ? [] : [{ id: "prompts" as const, value: prompts }]),
  ];
}

export function summarizeMigrationCredentials(secrets: CredentialSources): MigrationCredentialSummary {
  const apiKeyCount = Object.values(secrets.apiKeys)
    .flatMap((keys) => Object.values(keys))
    .filter(Boolean).length;
  const labels = [
    ...(apiKeyCount ? [`${apiKeyCount} 个 AI 渠道 API 密钥`] : []),
    ...(secrets.webdavPass ? ["WebDAV 密码"] : []),
    ...(secrets.objectStorageAccessKeyId || secrets.objectStorageSecretAccessKey ? ["对象存储访问凭据"] : []),
    ...(secrets.objectStorageSessionToken ? ["对象存储会话令牌"] : []),
  ];
  return { present: labels.length > 0, labels };
}
