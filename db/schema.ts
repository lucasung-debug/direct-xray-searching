export const presentationSchemaSql = "CREATE TABLE IF NOT EXISTS data_analytics_presentation_v1 (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, overrides_json TEXT NOT NULL)";

export const byokSecretsSchemaSql = "CREATE TABLE IF NOT EXISTS cpo_byok_secrets_v1 (secret_id TEXT PRIMARY KEY, cipher_b64 TEXT NOT NULL, iv_b64 TEXT NOT NULL, last4 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)";

export const geminiUsageSchemaSql = "CREATE TABLE IF NOT EXISTS cpo_gemini_usage_v1 (usage_day TEXT PRIMARY KEY, request_count INTEGER NOT NULL, updated_at TEXT NOT NULL)";

export const geminiLockSchemaSql = "CREATE TABLE IF NOT EXISTS cpo_gemini_lock_v1 (lock_id TEXT PRIMARY KEY, lease_until TEXT NOT NULL, updated_at TEXT NOT NULL)";
