import { getPgPool } from "@/lib/server/postgres";
import { createAdminUserIfMissing } from "@/lib/server/auth";

type LogKind = "image" | "video";

export async function ensureUserDataTables() {
    await createAdminUserIfMissing();
    const db = getPgPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_canvas_data (
            user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
            data_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_asset_data (
            user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
            data_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_generation_logs (
            user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
            data_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, kind)
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_files (
            user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            bytes BIGINT NOT NULL DEFAULT 0,
            content BYTEA NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, storage_key)
        )
    `);
}

async function readJsonRow(table: "user_canvas_data" | "user_asset_data", userId: string) {
    await ensureUserDataTables();
    const db = getPgPool();
    const result = await db.query<{ data_json: unknown }>(`SELECT data_json FROM ${table} WHERE user_id = $1 LIMIT 1`, [userId]);
    return result.rows[0]?.data_json || [];
}

async function writeJsonRow(table: "user_canvas_data" | "user_asset_data", userId: string, value: unknown) {
    await ensureUserDataTables();
    const db = getPgPool();
    await db.query(
        `
        INSERT INTO ${table} (user_id, data_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            data_json = EXCLUDED.data_json,
            updated_at = NOW()
        `,
        [userId, JSON.stringify(value)],
    );
}

export async function readUserProjects(userId: string) {
    return readJsonRow("user_canvas_data", userId);
}

export async function writeUserProjects(userId: string, projects: unknown) {
    await writeJsonRow("user_canvas_data", userId, projects);
}

export async function readUserAssets(userId: string) {
    return readJsonRow("user_asset_data", userId);
}

export async function writeUserAssets(userId: string, assets: unknown) {
    await writeJsonRow("user_asset_data", userId, assets);
}

export async function readUserLogs(userId: string, kind: LogKind) {
    await ensureUserDataTables();
    const db = getPgPool();
    const result = await db.query<{ data_json: unknown }>(`SELECT data_json FROM user_generation_logs WHERE user_id = $1 AND kind = $2 LIMIT 1`, [userId, kind]);
    return result.rows[0]?.data_json || [];
}

export async function writeUserLogs(userId: string, kind: LogKind, logs: unknown) {
    await ensureUserDataTables();
    const db = getPgPool();
    await db.query(
        `
        INSERT INTO user_generation_logs (user_id, kind, data_json, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (user_id, kind) DO UPDATE SET
            data_json = EXCLUDED.data_json,
            updated_at = NOW()
        `,
        [userId, kind, JSON.stringify(logs)],
    );
}

export async function upsertUserFile(userId: string, input: { storageKey: string; mimeType: string; bytes: number; content: Buffer }) {
    await ensureUserDataTables();
    const db = getPgPool();
    await db.query(
        `
        INSERT INTO user_files (user_id, storage_key, mime_type, bytes, content, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id, storage_key) DO UPDATE SET
            mime_type = EXCLUDED.mime_type,
            bytes = EXCLUDED.bytes,
            content = EXCLUDED.content,
            updated_at = NOW()
        `,
        [userId, input.storageKey, input.mimeType, input.bytes, input.content],
    );
}

export async function readUserFile(userId: string, storageKey: string) {
    await ensureUserDataTables();
    const db = getPgPool();
    const result = await db.query<{ mime_type: string; bytes: string; content: Buffer }>(
        `SELECT mime_type, bytes, content FROM user_files WHERE user_id = $1 AND storage_key = $2 LIMIT 1`,
        [userId, storageKey],
    );
    return result.rows[0] || null;
}

export async function deleteUserFiles(userId: string, keys: string[]) {
    await ensureUserDataTables();
    if (!keys.length) return;
    const db = getPgPool();
    await db.query(`DELETE FROM user_files WHERE user_id = $1 AND storage_key = ANY($2::text[])`, [userId, keys]);
}

export async function cleanupUserFiles(userId: string, usedKeys: string[], prefixes: string[]) {
    await ensureUserDataTables();
    const db = getPgPool();
    if (!prefixes.length) return;
    if (!usedKeys.length) {
        await db.query(
            `DELETE FROM user_files WHERE user_id = $1 AND (${prefixes.map((_, index) => `storage_key LIKE $${index + 2}`).join(" OR ")})`,
            [userId, ...prefixes.map((prefix) => `${prefix}%`)],
        );
        return;
    }
    await db.query(
        `
        DELETE FROM user_files
        WHERE user_id = $1
          AND storage_key <> ALL($2::text[])
          AND (${prefixes.map((_, index) => `storage_key LIKE $${index + 3}`).join(" OR ")})
        `,
        [userId, usedKeys, ...prefixes.map((prefix) => `${prefix}%`)],
    );
}
