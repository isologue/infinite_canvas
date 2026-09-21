import { createHash } from "node:crypto";

import { getPgPool } from "@/lib/server/postgres";
import type { RawPrompt } from "@/services/api/prompt-source-runtime";

export type PromptResourceStatus = "active" | "upstream_missing" | "admin_deleted";
export type PromptImageInput = { role: "cover" | "reference"; index: number; sourceUrl: string; mimeType: string; content: Buffer; contentHash: string };
export type StoredPrompt = { id: string; sourceId: string; sourceName: string; promptId: string; identityKey: string; title: string; status: PromptResourceStatus; contentHash: string; data: RawPrompt; sourceUrl: string };

const SCHEMA_LOCK_ID = 918204731;
let ensurePromise: Promise<void> | null = null;

export function ensurePromptResourceSchema() {
    if (!ensurePromise) {
        ensurePromise = createSchema().catch((error) => {
            ensurePromise = null;
            throw error;
        });
    }
    return ensurePromise;
}

async function createSchema() {
    const db = getPgPool();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_ID]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS prompt_resources (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                source_name TEXT NOT NULL DEFAULT '',
                prompt_id TEXT NOT NULL,
                identity_key TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('prompt', 'image')),
                image_role TEXT NOT NULL DEFAULT '',
                image_index INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'upstream_missing', 'admin_deleted')),
                title TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                mime_type TEXT NOT NULL DEFAULT '',
                bytes BIGINT NOT NULL DEFAULT 0,
                content BYTEA,
                content_hash TEXT NOT NULL DEFAULT '',
                last_seen_at TIMESTAMPTZ,
                deleted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (source_id, identity_key, kind, image_role, image_index)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_prompt_resources_source_status ON prompt_resources (source_id, status, kind)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_prompt_resources_updated ON prompt_resources (updated_at DESC)`);
        await client.query(`DROP TABLE IF EXISTS prompt_cover_cache`);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function listDeletedIdentityKeys(sourceId: string) {
    await ensurePromptResourceSchema();
    const result = await getPgPool().query<{ identity_key: string }>(`SELECT identity_key FROM prompt_resources WHERE source_id = $1 AND kind = 'prompt' AND status = 'admin_deleted'`, [sourceId]);
    return new Set(result.rows.map((row) => row.identity_key));
}

export async function readStoredPrompt(sourceId: string, identityKey: string): Promise<StoredPrompt | null> {
    await ensurePromptResourceSchema();
    const result = await getPgPool().query<any>(
        `SELECT id, source_id, source_name, prompt_id, identity_key, title, status, content_hash, data_json, source_url
         FROM prompt_resources WHERE source_id = $1 AND identity_key = $2 AND kind = 'prompt' LIMIT 1`,
        [sourceId, identityKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, sourceId: row.source_id, sourceName: row.source_name, promptId: row.prompt_id, identityKey: row.identity_key, title: row.title, status: row.status, contentHash: row.content_hash, data: row.data_json, sourceUrl: row.source_url };
}

export async function touchStoredPrompt(sourceId: string, identityKey: string, sourceName: string) {
    await ensurePromptResourceSchema();
    await getPgPool().query(
        `UPDATE prompt_resources SET source_name = $3, status = 'active', last_seen_at = NOW(), deleted_at = NULL, updated_at = NOW()
         WHERE source_id = $1 AND identity_key = $2 AND kind = 'prompt' AND status <> 'admin_deleted'`,
        [sourceId, identityKey, sourceName],
    );
}

export async function upsertPromptBundle(input: { sourceId: string; sourceName: string; promptId: string; identityKey: string; title: string; sourceUrl: string; data: RawPrompt; contentHash: string; images: PromptImageInput[] }) {
    await ensurePromptResourceSchema();
    const db = getPgPool();
    const client = await db.connect();
    const promptResourceId = resourceId(input.sourceId, input.identityKey, "prompt", "", 0);
    try {
        await client.query("BEGIN");
        const tombstone = await client.query(`SELECT 1 FROM prompt_resources WHERE source_id = $1 AND identity_key = $2 AND kind = 'prompt' AND status = 'admin_deleted' FOR UPDATE`, [input.sourceId, input.identityKey]);
        if (tombstone.rowCount) {
            await client.query("ROLLBACK");
            return false;
        }
        await client.query(
            `INSERT INTO prompt_resources (id, source_id, source_name, prompt_id, identity_key, kind, status, title, source_url, data_json, content_hash, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, 'prompt', 'active', $6, $7, $8::jsonb, $9, NOW())
             ON CONFLICT (source_id, identity_key, kind, image_role, image_index) DO UPDATE SET
                id = EXCLUDED.id, source_name = EXCLUDED.source_name, prompt_id = EXCLUDED.prompt_id, status = 'active', title = EXCLUDED.title,
                source_url = EXCLUDED.source_url, data_json = EXCLUDED.data_json, content_hash = EXCLUDED.content_hash,
                last_seen_at = NOW(), deleted_at = NULL, updated_at = NOW()`,
            [promptResourceId, input.sourceId, input.sourceName, input.promptId, input.identityKey, input.title, input.sourceUrl, JSON.stringify(input.data), input.contentHash],
        );
        await client.query(`DELETE FROM prompt_resources WHERE source_id = $1 AND identity_key = $2 AND kind = 'image'`, [input.sourceId, input.identityKey]);
        for (const image of input.images) {
            await client.query(
                `INSERT INTO prompt_resources (id, source_id, source_name, prompt_id, identity_key, kind, image_role, image_index, status, title, source_url, mime_type, bytes, content, content_hash, last_seen_at)
                 VALUES ($1, $2, $3, $4, $5, 'image', $6, $7, 'active', $8, $9, $10, $11, $12, $13, NOW())`,
                [resourceId(input.sourceId, input.identityKey, "image", image.role, image.index), input.sourceId, input.sourceName, input.promptId, input.identityKey, image.role, image.index, input.title, image.sourceUrl, image.mimeType, image.content.length, image.content, image.contentHash],
            );
        }
        await client.query("COMMIT");
        return true;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function markMissingPrompts(sourceId: string, seenIdentityKeys: string[]) {
    await ensurePromptResourceSchema();
    const db = getPgPool();
    if (!seenIdentityKeys.length) {
        await db.query(`UPDATE prompt_resources SET status = 'upstream_missing', updated_at = NOW() WHERE source_id = $1 AND kind = 'prompt' AND status = 'active'`, [sourceId]);
        return;
    }
    await db.query(
        `UPDATE prompt_resources SET status = 'upstream_missing', updated_at = NOW()
         WHERE source_id = $1 AND kind = 'prompt' AND status = 'active' AND NOT (identity_key = ANY($2::text[]))`,
        [sourceId, seenIdentityKeys],
    );
}

export async function countVisiblePrompts(sourceId: string) {
    await ensurePromptResourceSchema();
    const result = await getPgPool().query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM prompt_resources WHERE source_id = $1 AND kind = 'prompt' AND status IN ('active', 'upstream_missing')`, [sourceId]);
    return Number(result.rows[0]?.count || 0);
}

export async function listPrompts(input: { keyword?: string; tags?: string[]; sourceId?: string; sourceIds?: string[]; category?: string; page?: number; pageSize?: number }) {
    await ensurePromptResourceSchema();
    const page = Math.max(1, input.page || 1);
    const pageSize = Math.max(1, Math.min(1000, input.pageSize || 20));
    const values: unknown[] = [];
    const where = [`kind = 'prompt'`, `status IN ('active', 'upstream_missing')`];
    if (input.sourceIds) {
        if (!input.sourceIds.length) return { items: [], tags: [], total: 0 };
        values.push(input.sourceIds);
        where.push(`source_id = ANY($${values.length}::text[])`);
    }
    if (input.sourceId) {
        values.push(input.sourceId);
        where.push(`source_id = $${values.length}`);
    } else if (input.category) {
        values.push(input.category);
        where.push(`source_name = $${values.length}`);
    }
    if (input.keyword?.trim()) {
        values.push(`%${input.keyword.trim()}%`);
        where.push(`(title ILIKE $${values.length} OR source_name ILIKE $${values.length} OR COALESCE(data_json->>'prompt', '') ILIKE $${values.length} OR COALESCE(data_json->>'description', '') ILIKE $${values.length})`);
    }
    if (input.tags?.length) {
        values.push(input.tags);
        where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(data_json->'tags', '[]'::jsonb)) tag WHERE tag = ANY($${values.length}::text[]))`);
    }
    const clause = where.join(" AND ");
    const db = getPgPool();
    const totalResult = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM prompt_resources WHERE ${clause}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await db.query<any>(
        `SELECT id, source_id, source_name, prompt_id, identity_key, status, title, source_url, data_json, last_seen_at, updated_at
         FROM prompt_resources WHERE ${clause} ORDER BY updated_at DESC, title ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
    );
    const prompts = await attachImages(rows.rows);
    const tagValues: unknown[] = [];
    const tagWhere = [`kind = 'prompt'`, `status IN ('active', 'upstream_missing')`];
    if (input.sourceIds) {
        tagValues.push(input.sourceIds);
        tagWhere.push(`source_id = ANY($${tagValues.length}::text[])`);
    }
    if (input.sourceId) {
        tagValues.push(input.sourceId);
        tagWhere.push(`source_id = $${tagValues.length}`);
    } else if (input.category) {
        tagValues.push(input.category);
        tagWhere.push(`source_name = $${tagValues.length}`);
    }
    const tagsResult = await db.query<{ tag: string }>(
        `SELECT DISTINCT jsonb_array_elements_text(COALESCE(data_json->'tags', '[]'::jsonb)) AS tag
         FROM prompt_resources WHERE ${tagWhere.join(" AND ")} ORDER BY tag`,
        tagValues,
    );
    return { items: prompts, tags: tagsResult.rows.map((row) => row.tag).filter(Boolean), total: Number(totalResult.rows[0]?.count || 0) };
}

async function attachImages(rows: any[]) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const images = await getPgPool().query<any>(
        `SELECT id, source_id, identity_key, image_role, image_index FROM prompt_resources
         WHERE kind = 'image' AND status <> 'admin_deleted' AND EXISTS (
            SELECT 1 FROM prompt_resources prompt WHERE prompt.id = ANY($1::text[]) AND prompt.source_id = prompt_resources.source_id AND prompt.identity_key = prompt_resources.identity_key
         ) ORDER BY image_role, image_index`,
        [ids],
    );
    const byPrompt = new Map<string, any[]>();
    for (const image of images.rows) {
        const key = `${image.source_id}\n${image.identity_key}`;
        const list = byPrompt.get(key) || [];
        list.push(image);
        byPrompt.set(key, list);
    }
    return rows.map((row) => {
        const data = row.data_json || {};
        const bundleImages = byPrompt.get(`${row.source_id}\n${row.identity_key}`) || [];
        const cover = bundleImages.find((image) => image.image_role === "cover");
        const references = bundleImages.filter((image) => image.image_role === "reference").sort((a, b) => a.image_index - b.image_index);
        return {
            ...data,
            id: row.prompt_id,
            title: row.title,
            sourceId: row.source_id,
            category: row.source_name,
            githubUrl: row.source_url,
            status: row.status,
            coverUrl: cover ? contentUrl(cover.id) : "",
            referenceImageUrls: references.map((image) => contentUrl(image.id)),
        };
    });
}

export async function readPromptImage(id: string, sourceIds?: string[]) {
    await ensurePromptResourceSchema();
    if (sourceIds && !sourceIds.length) return null;
    const result = await getPgPool().query<{ mime_type: string; bytes: string; content: Buffer; content_hash: string }>(
        `SELECT mime_type, bytes, content, content_hash FROM prompt_resources
         WHERE id = $1 AND kind = 'image' AND status <> 'admin_deleted' AND content IS NOT NULL${sourceIds ? " AND source_id = ANY($2::text[])" : ""} LIMIT 1`,
        sourceIds ? [id, sourceIds] : [id],
    );
    const row = result.rows[0];
    return row ? { mimeType: row.mime_type, bytes: Number(row.bytes || 0), content: row.content, etag: row.content_hash } : null;
}

export async function listAdminPromptResources(input: { page: number; pageSize: number; keyword?: string; sourceId?: string; status?: string }) {
    await ensurePromptResourceSchema();
    const values: unknown[] = [];
    const where = [`prompt.kind = 'prompt'`];
    if (input.sourceId) { values.push(input.sourceId); where.push(`prompt.source_id = $${values.length}`); }
    if (["active", "upstream_missing", "admin_deleted"].includes(input.status || "")) { values.push(input.status); where.push(`prompt.status = $${values.length}`); }
    if (input.keyword?.trim()) {
        values.push(`%${input.keyword.trim()}%`);
        const keywordParam = `$${values.length}`;
        where.push(`(prompt.title ILIKE ${keywordParam} OR prompt.source_name ILIKE ${keywordParam} OR COALESCE(prompt.data_json->>'prompt', '') ILIKE ${keywordParam} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(prompt.data_json->'tags', '[]'::jsonb)) tag WHERE tag ILIKE ${keywordParam}))`);
    }
    const clause = where.join(" AND ");
    const db = getPgPool();
    const total = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM prompt_resources prompt WHERE ${clause}`, values);
    const storage = await db.query<{ total_bytes: string }>(`SELECT COALESCE(SUM(bytes), 0)::text AS total_bytes FROM prompt_resources WHERE kind = 'image' AND content IS NOT NULL`);
    values.push(input.pageSize, (input.page - 1) * input.pageSize);
    const result = await db.query<any>(
        `SELECT prompt.id, prompt.source_id, prompt.source_name, prompt.prompt_id, prompt.identity_key, prompt.status, prompt.title, prompt.data_json,
                prompt.last_seen_at, prompt.deleted_at, prompt.updated_at,
                COUNT(image.id)::text AS image_count, COALESCE(SUM(image.bytes), 0)::text AS total_bytes
         FROM prompt_resources prompt
         LEFT JOIN prompt_resources image ON image.source_id = prompt.source_id AND image.identity_key = prompt.identity_key AND image.kind = 'image'
         WHERE ${clause}
         GROUP BY prompt.id ORDER BY prompt.updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
    );
    const items = await attachImages(result.rows);
    return {
        items: result.rows.map((row, index) => ({ ...items[index], resourceId: row.id, identityKey: row.identity_key, imageCount: Number(row.image_count || 0), totalBytes: Number(row.total_bytes || 0), lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : "", deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : "", updatedAt: new Date(row.updated_at).toISOString() })),
        total: Number(total.rows[0]?.count || 0),
        totalBytes: Number(storage.rows[0]?.total_bytes || 0),
    };
}

export async function deletePromptBundles(ids: string[]) {
    await ensurePromptResourceSchema();
    const db = getPgPool();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const bundles = await client.query<{ source_id: string; source_name: string; prompt_id: string; identity_key: string; title: string }>(
            `SELECT source_id, source_name, prompt_id, identity_key, title FROM prompt_resources WHERE id = ANY($1::text[]) AND kind = 'prompt' FOR UPDATE`,
            [ids],
        );
        for (const row of bundles.rows) {
            await client.query(`DELETE FROM prompt_resources WHERE source_id = $1 AND identity_key = $2 AND kind = 'image'`, [row.source_id, row.identity_key]);
            await client.query(
                `UPDATE prompt_resources SET status = 'admin_deleted', source_url = '', data_json = '{}'::jsonb, mime_type = '', bytes = 0, content = NULL,
                    content_hash = '', last_seen_at = NULL, deleted_at = NOW(), updated_at = NOW()
                 WHERE source_id = $1 AND identity_key = $2 AND kind = 'prompt'`,
                [row.source_id, row.identity_key],
            );
        }
        await client.query("COMMIT");
        return bundles.rowCount || 0;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

function resourceId(sourceId: string, identityKey: string, kind: string, role: string, index: number) {
    return `prompt:${createHash("sha256").update(`${sourceId}\n${identityKey}\n${kind}\n${role}\n${index}`).digest("hex")}`;
}

function contentUrl(id: string) {
    return `/api/prompts/resources/${encodeURIComponent(id)}/content`;
}


