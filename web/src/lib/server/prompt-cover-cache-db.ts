import { getPgPool } from "@/lib/server/postgres";

const PROMPT_COVER_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PROMPT_COVER_CACHE_MAX_AGE_DAYS = 30;
const PROMPT_COVER_CACHE_MAX_ROWS = 2000;

export async function ensurePromptCoverCacheTable() {
    const db = getPgPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS prompt_cover_cache (
            source_url TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            bytes BIGINT NOT NULL DEFAULT 0,
            content BYTEA NOT NULL,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

export async function readPromptCoverCache(sourceUrl: string) {
    await ensurePromptCoverCacheTable();
    const db = getPgPool();
    const result = await db.query<{ mime_type: string; bytes: string; content: Buffer; fetched_at: Date }>(
        `SELECT mime_type, bytes, content, fetched_at FROM prompt_cover_cache WHERE source_url = $1 LIMIT 1`,
        [sourceUrl],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
        mimeType: row.mime_type,
        bytes: Number(row.bytes || 0),
        content: row.content,
        fetchedAt: row.fetched_at,
        stale: Date.now() - new Date(row.fetched_at).getTime() > PROMPT_COVER_CACHE_TTL_MS,
    };
}

export async function writePromptCoverCache(sourceUrl: string, input: { mimeType: string; bytes: number; content: Buffer }) {
    await ensurePromptCoverCacheTable();
    const db = getPgPool();
    await db.query(
        `
        INSERT INTO prompt_cover_cache (source_url, mime_type, bytes, content, fetched_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (source_url) DO UPDATE SET
            mime_type = EXCLUDED.mime_type,
            bytes = EXCLUDED.bytes,
            content = EXCLUDED.content,
            fetched_at = NOW(),
            updated_at = NOW()
        `,
        [sourceUrl, input.mimeType, input.bytes, input.content],
    );
    await cleanupPromptCoverCache();
}

async function cleanupPromptCoverCache() {
    const db = getPgPool();
    await db.query(
        `
        DELETE FROM prompt_cover_cache
        WHERE fetched_at < NOW() - ($1::text || ' days')::interval
        `,
        [String(PROMPT_COVER_CACHE_MAX_AGE_DAYS)],
    );
    await db.query(
        `
        DELETE FROM prompt_cover_cache
        WHERE source_url IN (
            SELECT source_url
            FROM prompt_cover_cache
            ORDER BY fetched_at DESC
            OFFSET $1
        )
        `,
        [PROMPT_COVER_CACHE_MAX_ROWS],
    );
}
