import { randomUUID } from "node:crypto";

import { getPgPool } from "@/lib/server/postgres";
import { ensureUserDataTables } from "@/lib/server/user-data-db";

export type ResourceKind = "image" | "video" | "audio" | "text";
export type RetentionSettings = { imageDays: number; videoDays: number; audioDays: number; textDays: number; lastRunAt: string | null; lastResult: unknown };

const BACKFILL_LOCK_ID = 482031948;
const CLEANUP_LOCK_ID = 482031949;

export async function saveUserFileResource(userId: string, input: { storageKey: string; mimeType: string; bytes: number; content: Buffer; title?: string; source?: string; metadata?: unknown }) {
    await ensureUserDataTables();
    const kind = mediaKind(input.mimeType, input.storageKey);
    const client = await getPgPool().connect();
    try {
        await client.query("BEGIN");
        if (kind && !input.storageKey.startsWith("preview:")) {
            await client.query(
                `INSERT INTO user_resources (user_id, resource_id, kind, storage_key, title, mime_type, bytes, source, metadata_json)
                 VALUES ($1, $2, $3, $2, $4, $5, $6, $7, $8::jsonb)
                 ON CONFLICT (user_id, resource_id) DO UPDATE SET title = CASE WHEN $9 THEN EXCLUDED.title ELSE user_resources.title END, mime_type = EXCLUDED.mime_type, bytes = EXCLUDED.bytes, source = CASE WHEN EXCLUDED.source <> '' THEN EXCLUDED.source ELSE user_resources.source END, metadata_json = user_resources.metadata_json || EXCLUDED.metadata_json, deleted_at = NULL, updated_at = NOW()`,
                [userId, input.storageKey, kind, input.title?.trim() || input.storageKey, input.mimeType, input.bytes, input.source || "upload", JSON.stringify(input.metadata || {}), Boolean(input.title?.trim())],
            );
        }
        await client.query(
            `INSERT INTO user_files (user_id, storage_key, mime_type, bytes, content, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (user_id, storage_key) DO UPDATE SET mime_type = EXCLUDED.mime_type, bytes = EXCLUDED.bytes, content = EXCLUDED.content, updated_at = NOW()`,
            [userId, input.storageKey, input.mimeType, input.bytes, input.content],
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function registerTextResource(userId: string, input: { resourceId?: string; title?: string; content: string; source?: string; createdAt?: string; isSaved?: boolean; metadata?: unknown }) {
    await ensureUserDataTables();
    const resourceId = input.resourceId || `text:${randomUUID()}`;
    const createdAt = input.createdAt && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : new Date().toISOString();
    await getPgPool().query(
        `INSERT INTO user_resources (user_id, resource_id, kind, title, text_content, mime_type, bytes, source, metadata_json, is_saved, created_at, updated_at)
         VALUES ($1, $2, 'text', $3, $4, 'text/plain', $5, $6, $7::jsonb, $8, $9, NOW())
         ON CONFLICT (user_id, resource_id) DO UPDATE SET title = EXCLUDED.title, text_content = EXCLUDED.text_content, bytes = EXCLUDED.bytes, source = EXCLUDED.source, metadata_json = user_resources.metadata_json || EXCLUDED.metadata_json, is_saved = EXCLUDED.is_saved, updated_at = NOW() WHERE user_resources.deleted_at IS NULL`,
        [userId, resourceId, input.title?.trim() || "文本资源", input.content, Buffer.byteLength(input.content), input.source || "generated", JSON.stringify(input.metadata || {}), Boolean(input.isSaved), createdAt],
    );
    return resourceId;
}

export async function syncUserSavedResources(userId: string, assets: unknown) {
    await ensureUserDataTables();
    const list = Array.isArray(assets) ? assets : [];
    const db = getPgPool();
    await db.query(`UPDATE user_resources SET is_saved = FALSE, updated_at = NOW() WHERE user_id = $1 AND is_saved`, [userId]);
    for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const asset = raw as Record<string, any>;
        const storageKey = typeof asset.data?.storageKey === "string" ? asset.data.storageKey : "";
        if (storageKey) {
            await db.query(`UPDATE user_resources SET is_saved = TRUE, title = CASE WHEN $3 <> '' THEN $3 ELSE title END, updated_at = NOW() WHERE user_id = $1 AND storage_key = $2`, [userId, storageKey, typeof asset.title === "string" ? asset.title : ""]);
        } else if (asset.kind === "text" && typeof asset.data?.content === "string") {
            await registerTextResource(userId, { resourceId: `text:${asset.id || randomUUID()}`, title: asset.title, content: asset.data.content, source: asset.source || "assets", createdAt: asset.createdAt, isSaved: true, metadata: asset.metadata });
        }
    }
}

export async function markDeletedAssetResources(userId: string, assets: unknown) {
    await ensureUserDataTables();
    if (!Array.isArray(assets) || !assets.length) return assets;
    const ids = assets.map((raw: any) => raw?.data?.storageKey || (raw?.kind === "text" && raw?.id ? `text:${raw.id}` : "")).filter(Boolean);
    if (!ids.length) return assets;
    const rows = await getPgPool().query<{ resource_id: string; storage_key: string | null }>(`SELECT resource_id, storage_key FROM user_resources WHERE user_id = $1 AND deleted_at IS NOT NULL AND (resource_id = ANY($2::text[]) OR storage_key = ANY($2::text[]))`, [userId, ids]);
    const deleted = new Set(rows.rows.flatMap((row) => [row.resource_id, row.storage_key || ""]));
    return assets.map((raw: any) => {
        const key = raw?.data?.storageKey || (raw?.kind === "text" && raw?.id ? `text:${raw.id}` : "");
        if (deleted.has(key)) return { ...raw, metadata: { ...(raw.metadata || {}), resourceDeleted: true } };
        if (raw?.metadata?.resourceDeleted === true) {
            const metadata = { ...raw.metadata };
            delete metadata.resourceDeleted;
            return { ...raw, metadata };
        }
        return raw;
    });
}

export async function ensureResourceBackfill() {
    await ensureUserDataTables();
    const db = getPgPool();
    const client = await db.connect();
    let committed = false;
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [BACKFILL_LOCK_ID]);
        const state = await client.query<{ backfilled_at: Date | null }>(`SELECT backfilled_at FROM resource_retention_settings WHERE id = TRUE`);
        if (state.rows[0]?.backfilled_at) {
            await client.query("COMMIT");
            return;
        }
        await client.query(`
            INSERT INTO user_resources (user_id, resource_id, kind, storage_key, title, mime_type, bytes, source, created_at, updated_at)
            SELECT user_id, storage_key,
                CASE WHEN mime_type LIKE 'image/%' THEN 'image' WHEN mime_type LIKE 'video/%' THEN 'video' WHEN mime_type LIKE 'audio/%' THEN 'audio' ELSE NULL END,
                storage_key, storage_key, mime_type, bytes, 'legacy', updated_at, updated_at
            FROM user_files
            WHERE storage_key NOT LIKE 'preview:%' AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%' OR mime_type LIKE 'audio/%')
            ON CONFLICT (user_id, resource_id) DO NOTHING
        `);
        const assets = await client.query<{ user_id: string; data_json: unknown }>(`SELECT user_id, data_json FROM user_asset_data`);
        const projects = await client.query<{ user_id: string; project_id: string; data_json: unknown }>(`SELECT user_id, project_id, data_json FROM user_canvas_projects`);
        await client.query("COMMIT");
        committed = true;
        for (const row of assets.rows) await syncUserSavedResources(row.user_id, row.data_json);
        for (const row of projects.rows) {
            const data = row.data_json && typeof row.data_json === "object" ? row.data_json as Record<string, unknown> : {};
            const nodes = Array.isArray(data.nodes) ? data.nodes : [];
            for (const raw of nodes) {
                if (!raw || typeof raw !== "object") continue;
                const node = raw as Record<string, any>;
                const content = typeof node.metadata?.content === "string" ? node.metadata.content : "";
                if (node.type !== "text" || !node.id || !content.trim() || !node.metadata?.prompt) continue;
                await registerTextResource(row.user_id, { resourceId: `text:canvas:${row.project_id}:${node.id}`, title: typeof node.title === "string" ? node.title : "生成文本", content, source: "canvas-backfill", metadata: { projectId: row.project_id, nodeId: node.id, prompt: node.metadata.prompt } });
            }
        }
        await db.query(`UPDATE resource_retention_settings SET backfilled_at = NOW(), updated_at = NOW() WHERE id = TRUE`);
    } catch (error) {
        if (!committed) await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function listAdminResources(query: { page: number; pageSize: number; kind?: string; saved?: string; keyword?: string; userId?: string; source?: string; from?: string; to?: string }) {
    await ensureResourceBackfill();
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => (params.push(value), `$${params.length}`);
    if (["image", "video", "audio", "text"].includes(query.kind || "")) where.push(`r.kind = ${add(query.kind)}`);
    if (query.saved === "true" || query.saved === "false") where.push(`r.is_saved = ${add(query.saved === "true")}`);
    if (query.userId) where.push(`r.user_id = ${add(query.userId)}`);
    if (query.source) where.push(`r.source = ${add(query.source)}`);
    if (query.from && Number.isFinite(Date.parse(query.from))) where.push(`r.created_at >= ${add(query.from)}`);
    if (query.to && Number.isFinite(Date.parse(query.to))) where.push(`r.created_at <= ${add(query.to)}`);
    if (query.keyword) {
        const term = `%${query.keyword}%`;
        const p = add(term);
        where.push(`(r.title ILIKE ${p} OR r.storage_key ILIKE ${p} OR r.text_content ILIKE ${p} OR u.username ILIKE ${p} OR u.display_name ILIKE ${p})`);
    }
    where.unshift(`r.deleted_at IS NULL`);
    const clause = `WHERE ${where.join(" AND ")}`;
    const db = getPgPool();
    const count = await db.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM user_resources r JOIN app_users u ON u.id = r.user_id ${clause}`, params);
    const offset = (query.page - 1) * query.pageSize;
    const rows = await db.query(
        `SELECT r.user_id, r.resource_id, r.kind, r.storage_key, r.title, r.mime_type, r.bytes, r.source, r.metadata_json, r.is_saved, r.created_at, r.updated_at, u.username, u.display_name
         FROM user_resources r JOIN app_users u ON u.id = r.user_id ${clause} ORDER BY r.created_at DESC LIMIT ${add(query.pageSize)} OFFSET ${add(offset)}`,
        params,
    );
    const stats = await db.query<{ kind: ResourceKind; count: string; bytes: string }>(`SELECT kind, COUNT(*)::text AS count, COALESCE(SUM(bytes), 0)::text AS bytes FROM user_resources WHERE deleted_at IS NULL GROUP BY kind`);
    return { items: rows.rows.map(mapResource), total: Number(count.rows[0]?.total || 0), stats: stats.rows.map((row) => ({ kind: row.kind, count: Number(row.count), bytes: Number(row.bytes) })) };
}

export async function readAdminResource(userId: string, resourceId: string) {
    await ensureResourceBackfill();
    const result = await getPgPool().query(`SELECT * FROM user_resources WHERE user_id = $1 AND resource_id = $2 AND deleted_at IS NULL LIMIT 1`, [userId, resourceId]);
    return result.rows[0] ? mapResource(result.rows[0]) : null;
}

export async function deleteAdminResources(items: Array<{ userId: string; resourceId: string }>) {
    await ensureResourceBackfill();
    if (!items.length) return { deleted: 0, bytes: 0 };
    const db = getPgPool();
    const client = await db.connect();
    let bytes = 0;
    let deleted = 0;
    try {
        await client.query("BEGIN");
        for (const item of items) {
            const row = await client.query<{ storage_key: string | null; bytes: string }>(`SELECT storage_key, bytes FROM user_resources WHERE user_id = $1 AND resource_id = $2 AND deleted_at IS NULL FOR UPDATE`, [item.userId, item.resourceId]);
            if (!row.rows[0]) continue;
            await client.query(`UPDATE user_resources SET deleted_at = NOW(), text_content = '', bytes = 0, updated_at = NOW() WHERE user_id = $1 AND resource_id = $2`, [item.userId, item.resourceId]);
            deleted += 1;
            bytes += Number(row.rows[0].bytes || 0);
            if (row.rows[0].storage_key) await client.query(`DELETE FROM user_files WHERE user_id = $1 AND storage_key = ANY($2::text[])`, [item.userId, [row.rows[0].storage_key, `preview:${row.rows[0].storage_key}`]]);
        }
        await client.query("COMMIT");
        return { deleted, bytes };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function clearAdminResources() {
    await ensureResourceBackfill();
    const db = getPgPool();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query(`LOCK TABLE user_resources, user_files IN SHARE ROW EXCLUSIVE MODE`);
        const stats = await client.query<{ count: string; bytes: string }>(`SELECT COUNT(*)::text AS count, COALESCE(SUM(bytes), 0)::text AS bytes FROM user_resources WHERE deleted_at IS NULL`);
        await client.query(`UPDATE user_resources SET deleted_at = NOW(), text_content = '', bytes = 0, updated_at = NOW() WHERE deleted_at IS NULL`);
        await client.query(`DELETE FROM user_files`);
        await client.query("COMMIT");
        return { deleted: Number(stats.rows[0]?.count || 0), bytes: Number(stats.rows[0]?.bytes || 0) };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function readRetentionSettings(): Promise<RetentionSettings> {
    await ensureUserDataTables();
    const row = (await getPgPool().query(`SELECT * FROM resource_retention_settings WHERE id = TRUE`)).rows[0];
    return { imageDays: row.image_days, videoDays: row.video_days, audioDays: row.audio_days, textDays: row.text_days, lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null, lastResult: row.last_result_json };
}

export async function writeRetentionSettings(input: Record<string, unknown>) {
    const values = ["imageDays", "videoDays", "audioDays", "textDays"].map((key) => Math.max(0, Math.min(36500, Math.floor(Number(input[key]) || 0))));
    await ensureUserDataTables();
    await getPgPool().query(`UPDATE resource_retention_settings SET image_days = $1, video_days = $2, audio_days = $3, text_days = $4, updated_at = NOW() WHERE id = TRUE`, values);
    return readRetentionSettings();
}

export async function runResourceCleanup(force = false) {
    await ensureResourceBackfill();
    const db = getPgPool();
    const client = await db.connect();
    const runAt = new Date().toISOString();
    try {
        await client.query("BEGIN");
        const locked = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS locked`, [CLEANUP_LOCK_ID]);
        if (!locked.rows[0]?.locked) {
            await client.query("ROLLBACK");
            return { skipped: true, reason: "已有清理任务运行中" };
        }
        const setting = (await client.query(`SELECT * FROM resource_retention_settings WHERE id = TRUE FOR UPDATE`)).rows[0];
        if (!force && setting.last_run_at && Date.now() - new Date(setting.last_run_at).getTime() < 24 * 60 * 60 * 1000) {
            await client.query("COMMIT");
            return { skipped: true, reason: "今日已执行" };
        }
        const days: Record<ResourceKind, number> = { image: setting.image_days, video: setting.video_days, audio: setting.audio_days, text: setting.text_days };
        const result: Record<string, unknown> = { runAt };
        for (const kind of Object.keys(days) as ResourceKind[]) {
            if (!days[kind]) {
                result[kind] = { count: 0, bytes: 0 };
                continue;
            }
            const removed = await client.query<{ count: string; bytes: string }>(`
                WITH expired AS (
                    SELECT user_id, resource_id, bytes
                    FROM user_resources
                    WHERE kind = $1 AND deleted_at IS NULL AND NOT is_saved AND created_at < NOW() - ($2 * INTERVAL '1 day')
                    FOR UPDATE
                ), marked AS (
                    UPDATE user_resources AS resource
                    SET deleted_at = NOW(), text_content = '', bytes = 0, updated_at = NOW()
                    FROM expired
                    WHERE resource.user_id = expired.user_id AND resource.resource_id = expired.resource_id
                    RETURNING resource.user_id, resource.storage_key, expired.bytes
                ), deleted_files AS (
                    DELETE FROM user_files AS file
                    USING marked
                    WHERE marked.storage_key IS NOT NULL AND file.user_id = marked.user_id AND file.storage_key = ANY(ARRAY[marked.storage_key, 'preview:' || marked.storage_key])
                )
                SELECT COUNT(*)::text AS count, COALESCE(SUM(bytes), 0)::text AS bytes FROM marked
            `, [kind, days[kind]]);
            result[kind] = { count: Number(removed.rows[0]?.count || 0), bytes: Number(removed.rows[0]?.bytes || 0) };
        }
        await client.query(`UPDATE resource_retention_settings SET last_run_at = NOW(), last_result_json = $1::jsonb, updated_at = NOW() WHERE id = TRUE`, [JSON.stringify(result)]);
        await client.query("COMMIT");
        return { skipped: false, result };
    } catch (error) {
        await client.query("ROLLBACK");
        await db.query(`UPDATE resource_retention_settings SET last_result_json = $1::jsonb, updated_at = NOW() WHERE id = TRUE`, [JSON.stringify({ runAt, error: error instanceof Error ? error.message : String(error) })]).catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

function mediaKind(mimeType: string, storageKey: string): ResourceKind | null {
    if (mimeType.startsWith("image/") || storageKey.startsWith("image:")) return "image";
    if (mimeType.startsWith("video/") || storageKey.startsWith("video:")) return "video";
    if (mimeType.startsWith("audio/") || storageKey.startsWith("audio:")) return "audio";
    return null;
}

function mapResource(row: any) {
    return { userId: row.user_id, resourceId: row.resource_id, kind: row.kind, storageKey: row.storage_key || "", title: row.title, textContent: row.text_content || "", mimeType: row.mime_type, bytes: Number(row.bytes || 0), source: row.source, metadata: row.metadata_json || {}, isSaved: Boolean(row.is_saved), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), username: row.username || "", displayName: row.display_name || "" };
}
