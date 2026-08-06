import { getPgPool } from "@/lib/server/postgres";

export type VideoDownloadSettings = {
    enabled: boolean;
    allowedHosts: string[];
};

const defaultSettings: VideoDownloadSettings = { enabled: false, allowedHosts: [] };
let initialized = false;

export async function readVideoDownloadSettings(): Promise<VideoDownloadSettings> {
    await ensureSchema();
    const row = (await getPgPool().query<{ enabled: boolean; allowed_hosts: unknown }>("SELECT enabled, allowed_hosts FROM video_download_settings WHERE id = TRUE")).rows[0];
    return normalizeVideoDownloadSettings(row || defaultSettings);
}

export async function writeVideoDownloadSettings(input: unknown): Promise<VideoDownloadSettings> {
    const settings = normalizeVideoDownloadSettings(input, true);
    await ensureSchema();
    await getPgPool().query("UPDATE video_download_settings SET enabled = $1, allowed_hosts = $2::jsonb, updated_at = NOW() WHERE id = TRUE", [settings.enabled, JSON.stringify(settings.allowedHosts)]);
    return settings;
}

export function normalizeVideoDownloadSettings(input: unknown, strict = false): VideoDownloadSettings {
    const value = input && typeof input === "object" ? input as { enabled?: unknown; allowedHosts?: unknown; allowed_hosts?: unknown } : {};
    const hosts = Array.isArray(value.allowedHosts) ? value.allowedHosts : Array.isArray(value.allowed_hosts) ? value.allowed_hosts : [];
    const normalizedHosts = hosts.map(normalizeHost);
    if (strict && normalizedHosts.some((host) => !host)) throw new Error("Allowed video hosts must be complete domain names");
    const allowedHosts = [...new Set(normalizedHosts.filter(Boolean))];
    if (allowedHosts.length > 50) throw new Error("At most 50 allowed video hosts");
    return { enabled: value.enabled === true, allowedHosts };
}

function normalizeHost(value: unknown) {
    if (typeof value !== "string") return "";
    const host = value.trim().toLowerCase();
    if (!host || host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes(".") || /^\d+(?:\.\d+){3}$/.test(host)) return "";
    return host;
}

async function ensureSchema() {
    if (initialized) return;
    const db = getPgPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS video_download_settings (
            id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            allowed_hosts JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query("INSERT INTO video_download_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING");
    initialized = true;
}
