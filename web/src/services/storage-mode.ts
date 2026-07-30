/**
 * OpenBoard has one runtime persistence model: the authenticated server API,
 * backed by PostgreSQL and protected blob storage. Browser databases are only
 * read by the explicit legacy migration flow.
 */
export const DATABASE_STORAGE_ENABLED = true as const;
