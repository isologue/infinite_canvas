import { createHash, randomUUID } from "node:crypto";

import { getPgPool } from "@/lib/server/postgres";
import { ensurePromptResourceSchema } from "@/lib/server/prompt-resource-db";
import { DEFAULT_PROMPT_SOURCES, createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";

export type PromptSourceSchedule = {
    intervalMinutes: number;
    lastFetchedAt: string;
};

export type PromptSourceStatus = {
    sourceId: string;
    count: number;
    lastSuccessAt: string;
    lastSyncAt: string;
    lastError: string;
};

export type PromptSourceSettings = {
    sources: PromptSource[];
    schedule: PromptSourceSchedule;
    statuses: Record<string, PromptSourceStatus>;
};

const CONFIG_KEY = "prompt_sources";
const DEFAULT_SCHEDULE: PromptSourceSchedule = { intervalMinutes: 30, lastFetchedAt: "" };
let ensurePromise: Promise<void> | null = null;

export function ensurePromptSourceSettings() {
    if (!ensurePromise) {
        ensurePromise = ensureSchema().catch((error) => {
            ensurePromise = null;
            throw error;
        });
    }
    return ensurePromise;
}

async function ensureSchema() {
    const db = getPgPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS shared_configs (
            config_key TEXT PRIMARY KEY,
            config_json JSONB NOT NULL,
            webdav_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(
        `INSERT INTO shared_configs (config_key, config_json, webdav_json)
         VALUES ($1, $2::jsonb, '{}'::jsonb)
         ON CONFLICT (config_key) DO NOTHING`,
        [CONFIG_KEY, JSON.stringify(defaultSettings())],
    );
}

function defaultSettings(): PromptSourceSettings {
    return {
        sources: DEFAULT_PROMPT_SOURCES.map((source) => createPromptSource(source)),
        schedule: { ...DEFAULT_SCHEDULE },
        statuses: {},
    };
}

function normalizeSettings(value: unknown): PromptSourceSettings {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const sources = Array.isArray(record.sources) ? record.sources.map((source) => createPromptSource(source as Partial<PromptSource>)) : defaultSettings().sources;
    const rawSchedule = record.schedule && typeof record.schedule === "object" ? (record.schedule as Partial<PromptSourceSchedule>) : {};
    const rawStatuses = record.statuses && typeof record.statuses === "object" ? (record.statuses as Record<string, Partial<PromptSourceStatus>>) : {};
    const statuses = Object.fromEntries(
        sources.map((source) => {
            const status = rawStatuses[source.id] || {};
            return [source.id, {
                sourceId: source.id,
                count: Math.max(0, Number(status.count) || 0),
                lastSuccessAt: typeof status.lastSuccessAt === "string" ? status.lastSuccessAt : "",
                lastSyncAt: typeof status.lastSyncAt === "string" ? status.lastSyncAt : "",
                lastError: typeof status.lastError === "string" ? status.lastError : "",
            } satisfies PromptSourceStatus];
        }),
    );
    return {
        sources,
        schedule: {
            intervalMinutes: [0, 30, 60, 360, 1440].includes(Number(rawSchedule.intervalMinutes)) ? Number(rawSchedule.intervalMinutes) : DEFAULT_SCHEDULE.intervalMinutes,
            lastFetchedAt: typeof rawSchedule.lastFetchedAt === "string" ? rawSchedule.lastFetchedAt : "",
        },
        statuses,
    };
}

export async function readPromptSourceSettings(): Promise<PromptSourceSettings> {
    await ensurePromptSourceSettings();
    const result = await getPgPool().query<{ config_json: unknown }>(`SELECT config_json FROM shared_configs WHERE config_key = $1 LIMIT 1`, [CONFIG_KEY]);
    return normalizeSettings(result.rows[0]?.config_json);
}

export async function savePromptSource(source: PromptSource) {
    await Promise.all([ensurePromptSourceSettings(), ensurePromptResourceSchema()]);
    const db = getPgPool();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const row = await client.query<{ config_json: unknown }>(`SELECT config_json FROM shared_configs WHERE config_key = $1 FOR UPDATE`, [CONFIG_KEY]);
        const settings = normalizeSettings(row.rows[0]?.config_json);
        const normalized = createPromptSource({ ...source, id: source.id.trim() || randomUUID(), builtIn: false });
        const index = settings.sources.findIndex((item) => item.id === normalized.id);
        if (index >= 0) settings.sources[index] = normalized;
        else settings.sources.push(normalized);
        settings.statuses[normalized.id] ||= { sourceId: normalized.id, count: 0, lastSuccessAt: "", lastSyncAt: "", lastError: "" };
        await client.query(`UPDATE shared_configs SET config_json = $2::jsonb, updated_at = NOW() WHERE config_key = $1`, [CONFIG_KEY, JSON.stringify(settings)]);
        await client.query(`UPDATE prompt_resources SET source_name = $2, updated_at = NOW() WHERE source_id = $1`, [normalized.id, normalized.name]).catch(() => undefined);
        await client.query("COMMIT");
        return normalized;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function updatePromptSourceEnabled(id: string, enabled: boolean) {
    return updateSettings((settings) => {
        const source = settings.sources.find((item) => item.id === id);
        if (!source) throw new Error("提示词来源不存在");
        source.enabled = enabled;
    });
}

export async function updatePromptSourceSchedule(intervalMinutes: number) {
    const value = [0, 30, 60, 360, 1440].includes(intervalMinutes) ? intervalMinutes : 30;
    return updateSettings((settings) => {
        settings.schedule.intervalMinutes = value;
    });
}

export async function updatePromptSourceStatus(status: PromptSourceStatus, updateSchedule = false) {
    return updateSettings((settings) => {
        settings.statuses[status.sourceId] = status;
        if (updateSchedule) settings.schedule.lastFetchedAt = status.lastSyncAt;
    });
}

export async function replacePromptSourceSettings(input: { sources: PromptSource[]; schedule: PromptSourceSchedule }) {
    await Promise.all([ensurePromptSourceSettings(), ensurePromptResourceSchema()]);
    const db = getPgPool();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const row = await client.query<{ config_json: unknown }>(`SELECT config_json FROM shared_configs WHERE config_key = $1 FOR UPDATE`, [CONFIG_KEY]);
        const current = normalizeSettings(row.rows[0]?.config_json);
        const sources = input.sources.map((source) => createPromptSource({ ...source, builtIn: false }));
        const sourceIds = sources.map((source) => source.id);
        const statuses = Object.fromEntries(sourceIds.map((id) => [id, current.statuses[id] || { sourceId: id, count: 0, lastSuccessAt: "", lastSyncAt: "", lastError: "" }]));
        const settings = normalizeSettings({ sources, schedule: input.schedule, statuses });
        if (sourceIds.length) await client.query(`DELETE FROM prompt_resources WHERE NOT (source_id = ANY($1::text[]))`, [sourceIds]);
        else await client.query(`DELETE FROM prompt_resources`);
        await client.query(`UPDATE shared_configs SET config_json = $2::jsonb, updated_at = NOW() WHERE config_key = $1`, [CONFIG_KEY, JSON.stringify(settings)]);
        await client.query("COMMIT");
        return settings;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}
export async function deletePromptSource(id: string) {
    await Promise.all([ensurePromptSourceSettings(), ensurePromptResourceSchema()]);
    const db = getPgPool();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const row = await client.query<{ config_json: unknown }>(`SELECT config_json FROM shared_configs WHERE config_key = $1 FOR UPDATE`, [CONFIG_KEY]);
        const settings = normalizeSettings(row.rows[0]?.config_json);
        if (!settings.sources.some((source) => source.id === id)) throw new Error("提示词来源不存在");
        settings.sources = settings.sources.filter((source) => source.id !== id);
        delete settings.statuses[id];
        await client.query(`DELETE FROM prompt_resources WHERE source_id = $1`, [id]);
        await client.query(`UPDATE shared_configs SET config_json = $2::jsonb, updated_at = NOW() WHERE config_key = $1`, [CONFIG_KEY, JSON.stringify(settings)]);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function updateSettings(mutator: (settings: PromptSourceSettings) => void) {
    await ensurePromptSourceSettings();
    const db = getPgPool();
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const row = await client.query<{ config_json: unknown }>(`SELECT config_json FROM shared_configs WHERE config_key = $1 FOR UPDATE`, [CONFIG_KEY]);
        const settings = normalizeSettings(row.rows[0]?.config_json);
        mutator(settings);
        await client.query(`UPDATE shared_configs SET config_json = $2::jsonb, updated_at = NOW() WHERE config_key = $1`, [CONFIG_KEY, JSON.stringify(settings)]);
        await client.query("COMMIT");
        return settings;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export function promptSourceLockKey(sourceId: string) {
    return Number.parseInt(createHash("sha256").update(`prompt-source:${sourceId}`).digest("hex").slice(0, 8), 16) | 0;
}

