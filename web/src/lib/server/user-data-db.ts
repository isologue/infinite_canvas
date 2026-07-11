import { getPgPool } from "@/lib/server/postgres";
import { createAdminUserIfMissing } from "@/lib/server/auth";

type LogKind = "image" | "video";

let ensureTablesPromise: Promise<void> | null = null;

export function ensureUserDataTables() {
    if (!ensureTablesPromise) ensureTablesPromise = createUserDataTables().catch((error) => {
        ensureTablesPromise = null;
        throw error;
    });
    return ensureTablesPromise;
}

async function createUserDataTables() {
    await createAdminUserIfMissing();
    const db = getPgPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_canvas_projects (
            user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            node_count INTEGER NOT NULL DEFAULT 0,
            connection_count INTEGER NOT NULL DEFAULT 0,
            data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, project_id)
        )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_user_canvas_projects_updated ON user_canvas_projects (user_id, updated_at DESC)`);
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

async function readJsonRow(table: "user_asset_data", userId: string) {
    await ensureUserDataTables();
    const db = getPgPool();
    const result = await db.query<{ data_json: unknown }>(`SELECT data_json FROM ${table} WHERE user_id = $1 LIMIT 1`, [userId]);
    return result.rows[0]?.data_json || [];
}

async function writeJsonRow(table: "user_asset_data", userId: string, value: unknown) {
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

type CanvasProjectInput = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: unknown[];
    connections: unknown[];
    chatSessions: unknown[];
    activeChatId: string | null;
    backgroundMode: string;
    showImageInfo: boolean;
    viewport: unknown;
};

type CanvasProjectRow = {
    project_id: string;
    title: string;
    node_count: number;
    connection_count: number;
    data_json: Omit<CanvasProjectInput, "id" | "title" | "createdAt" | "updatedAt">;
    created_at: Date | string;
    updated_at: Date | string;
};

export async function listUserProjects(userId: string) {
    await ensureUserDataTables();
    const result = await getPgPool().query<Omit<CanvasProjectRow, "data_json">>(
        `SELECT project_id, title, node_count, connection_count, created_at, updated_at FROM user_canvas_projects WHERE user_id = $1 ORDER BY updated_at DESC`,
        [userId],
    );
    return result.rows.map(projectSummary);
}

export async function readUserProject(userId: string, projectId: string) {
    await ensureUserDataTables();
    const result = await getPgPool().query<CanvasProjectRow>(
        `SELECT project_id, title, node_count, connection_count, data_json, created_at, updated_at FROM user_canvas_projects WHERE user_id = $1 AND project_id = $2 LIMIT 1`,
        [userId, projectId],
    );
    const row = result.rows[0];
    return row ? projectFromRow(row) : null;
}

export async function hasUserProject(userId: string, projectId: string) {
    await ensureUserDataTables();
    const result = await getPgPool().query(`SELECT 1 FROM user_canvas_projects WHERE user_id = $1 AND project_id = $2 LIMIT 1`, [userId, projectId]);
    return Boolean(result.rowCount);
}

export async function upsertUserProject(userId: string, project: CanvasProjectInput) {
    await ensureUserDataTables();
    const data = projectData(project);
    const result = await getPgPool().query<CanvasProjectRow>(
        `
        INSERT INTO user_canvas_projects (user_id, project_id, title, node_count, connection_count, data_json, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        ON CONFLICT (user_id, project_id) DO UPDATE SET
            title = EXCLUDED.title,
            node_count = EXCLUDED.node_count,
            connection_count = EXCLUDED.connection_count,
            data_json = EXCLUDED.data_json,
            updated_at = EXCLUDED.updated_at
        RETURNING project_id, title, node_count, connection_count, data_json, created_at, updated_at
        `,
        [userId, project.id, project.title, project.nodes.length, project.connections.length, JSON.stringify(data), project.createdAt, project.updatedAt],
    );
    return projectFromRow(result.rows[0]);
}

export async function renameUserProject(userId: string, projectId: string, title: string) {
    await ensureUserDataTables();
    const result = await getPgPool().query<Omit<CanvasProjectRow, "data_json">>(
        `UPDATE user_canvas_projects SET title = $3, updated_at = NOW() WHERE user_id = $1 AND project_id = $2 RETURNING project_id, title, node_count, connection_count, created_at, updated_at`,
        [userId, projectId, title],
    );
    return result.rows[0] ? projectSummary(result.rows[0]) : null;
}

export async function deleteUserProjects(userId: string, projectIds: string[]) {
    await ensureUserDataTables();
    if (!projectIds.length) return;
    await getPgPool().query(`DELETE FROM user_canvas_projects WHERE user_id = $1 AND project_id = ANY($2::text[])`, [userId, projectIds]);
}

function projectData(project: CanvasProjectInput) {
    return {
        nodes: project.nodes,
        connections: project.connections,
        chatSessions: project.chatSessions,
        activeChatId: project.activeChatId,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    };
}

function projectFromRow(row: CanvasProjectRow) {
    return {
        id: row.project_id,
        title: row.title,
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        ...row.data_json,
    };
}

function projectSummary(row: Omit<CanvasProjectRow, "data_json">) {
    return {
        id: row.project_id,
        title: row.title,
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        nodeCount: row.node_count,
        connectionCount: row.connection_count,
    };
}

function isoDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

export async function readUserFileInfo(userId: string, storageKey: string) {
    await ensureUserDataTables();
    const result = await getPgPool().query<{ mime_type: string; bytes: string }>(
        `SELECT mime_type, bytes FROM user_files WHERE user_id = $1 AND storage_key = $2 LIMIT 1`,
        [userId, storageKey],
    );
    return result.rows[0] || null;
}

export async function readUserFileRange(userId: string, storageKey: string, start: number, length: number) {
    await ensureUserDataTables();
    const result = await getPgPool().query<{ content: Buffer }>(
        `SELECT substring(content FROM $3 FOR $4) AS content FROM user_files WHERE user_id = $1 AND storage_key = $2 LIMIT 1`,
        [userId, storageKey, start + 1, length],
    );
    return result.rows[0]?.content || null;
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
    const referenced = new Set(usedKeys);
    const [projects, assets, logs] = await Promise.all([
        db.query<{ data_json: unknown }>(`SELECT data_json FROM user_canvas_projects WHERE user_id = $1`, [userId]),
        db.query<{ data_json: unknown }>(`SELECT data_json FROM user_asset_data WHERE user_id = $1`, [userId]),
        db.query<{ data_json: unknown }>(`SELECT data_json FROM user_generation_logs WHERE user_id = $1`, [userId]),
    ]);
    [...projects.rows, ...assets.rows, ...logs.rows].forEach((row) => collectStorageKeys(row.data_json, referenced));
    const allUsedKeys = [...referenced];
    if (!allUsedKeys.length) {
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
        [userId, allUsedKeys, ...prefixes.map((prefix) => `${prefix}%`)],
    );
}

function collectStorageKeys(value: unknown, keys: Set<string>) {
    if (!value || typeof value !== "object") return;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
}
