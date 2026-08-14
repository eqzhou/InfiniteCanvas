export const AI_CALL_LOG_RETENTION_DEFAULT_DAYS = 30;
export const AI_CALL_LOG_RETENTION_MIN_DAYS = 1;
export const AI_CALL_LOG_RETENTION_MAX_DAYS = 3650;

export function normalizeAICallLogRetentionDays(value: number): number {
  const days = Math.floor(value) || AI_CALL_LOG_RETENTION_DEFAULT_DAYS;
  return Math.max(
    AI_CALL_LOG_RETENTION_MIN_DAYS,
    Math.min(AI_CALL_LOG_RETENTION_MAX_DAYS, days),
  );
}
