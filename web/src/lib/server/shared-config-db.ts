import { Pool } from "pg";

type SharedConfigRecord = {
    config: Record<string, unknown>;
    webdav: Record<string, unknown>;
};

const defaultConfig = {
    channelMode: "shared",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: "默认渠道",
            baseUrl: "https://api.openai.com",
            apiKey: "",
            apiFormat: "openai",
            models: ["gpt-image-2", "grok-imagine-video", "gpt-5.5", "gpt-4o-mini-tts"],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    imageModels: ["default::gpt-image-2"],
    videoModels: ["default::grok-imagine-video"],
    textModels: ["default::gpt-5.5"],
    audioModels: ["default::gpt-4o-mini-tts"],
    quality: "auto",
    size: "1:1",
    count: "1",
    canvasImageCount: "3",
};

const defaultWebdavConfig = {
    proxyMode: "direct",
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

declare global {
    // eslint-disable-next-line no-var
    var __infiniteCanvasPgPool: Pool | undefined;
}

function databaseUrl() {
    return process.env.DATABASE_URL || process.env.DATABASE_DSN || "";
}

function pool() {
    const connectionString = databaseUrl().trim();
    if (!connectionString) throw new Error("未配置 DATABASE_URL");
    if (!global.__infiniteCanvasPgPool) {
        global.__infiniteCanvasPgPool = new Pool({
            connectionString,
            ssl: connectionString.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
        });
    }
    return global.__infiniteCanvasPgPool;
}

let initialized = false;

async function ensureSchema() {
    if (initialized) return;
    const db = pool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS shared_configs (
            config_key TEXT PRIMARY KEY,
            config_json JSONB NOT NULL,
            webdav_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(
        `
        INSERT INTO shared_configs (config_key, config_json, webdav_json)
        VALUES ('global', $1::jsonb, $2::jsonb)
        ON CONFLICT (config_key) DO NOTHING
        `,
        [JSON.stringify(defaultConfig), JSON.stringify(defaultWebdavConfig)],
    );
    initialized = true;
}

export async function readSharedConfig(): Promise<SharedConfigRecord> {
    await ensureSchema();
    const db = pool();
    const result = await db.query<{ config_json: Record<string, unknown>; webdav_json: Record<string, unknown> }>("SELECT config_json, webdav_json FROM shared_configs WHERE config_key = 'global' LIMIT 1");
    const row = result.rows[0];
    return {
        config: { ...defaultConfig, ...(row?.config_json || {}) },
        webdav: { ...defaultWebdavConfig, ...(row?.webdav_json || {}) },
    };
}

export async function writeSharedConfig(record: SharedConfigRecord) {
    await ensureSchema();
    const db = pool();
    await db.query(
        `
        UPDATE shared_configs
        SET config_json = $1::jsonb,
            webdav_json = $2::jsonb,
            updated_at = NOW()
        WHERE config_key = 'global'
        `,
        [JSON.stringify(record.config), JSON.stringify(record.webdav)],
    );
    return readSharedConfig();
}

// ---- 每用户配置（方案 B）----
// 全局配置是渠道 URL/key 的唯一权威来源；普通用户各存一份自己的配置，
// 但渠道的 baseUrl/apiKey 始终被服务端用全局值回填，普通用户改不了（只能走超管配的中转）。

type ChannelLike = { id?: unknown; baseUrl?: unknown; apiKey?: unknown; [key: string]: unknown };

async function ensureUserConfigSchema() {
    const db = pool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_configs (
            user_id TEXT PRIMARY KEY,
            config_json JSONB NOT NULL,
            webdav_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(`ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS webdav_json JSONB NOT NULL DEFAULT '{}'::jsonb`);
}

// 普通用户渠道 baseUrl 的默认/锁定值，可用 env 配置。
 export function lockedChannelBaseUrls(): string[] {
     const raw = process.env.LOCKED_CHANNEL_BASE_URLS?.trim() || process.env.LOCKED_CHANNEL_BASE_URL?.trim() || process.env.NEXT_PUBLIC_LOCKED_CHANNEL_BASE_URLS?.trim() || process.env.NEXT_PUBLIC_LOCKED_CHANNEL_BASE_URL?.trim() || "https://moai.wiki";
     return raw.split(",").map((s) => s.trim()).filter(Boolean);
 }
 
 // 向后兼容：取第一个锁定 URL，或 https://moai.wiki
 export function lockedChannelBaseUrl() {
     return lockedChannelBaseUrls()[0] || "https://moai.wiki";
 }

// 普通用户所有渠道的 baseUrl 一律强制成锁定的中转地址；apiKey/模型等归用户自己。
// 只锁 URL，绝不读取或下发全局的 key（普通用户看不到 admin 的任何配置）。
 function enforceLockedBaseUrl(userConfig: Record<string, unknown>) {
     const lockedUrls = lockedChannelBaseUrls();
     const defaultLocked = lockedUrls[0] || "https://moai.wiki";
     const userChannels = Array.isArray(userConfig.channels) ? (userConfig.channels as ChannelLike[]) : [];
     const mergedChannels = userChannels.map((channel) => ({
         ...channel,
         baseUrl: lockedUrls.includes(channel.baseUrl as string) ? channel.baseUrl : defaultLocked,
     }));
     const result: Record<string, unknown> = { ...userConfig, channels: mergedChannels };
     result.baseUrl = defaultLocked;
     return result;
 }

// 普通用户首次进来的空白配置：一个渠道（URL 锁定、key 空、无模型），其余取代码默认。
// 绝不包含 admin 全局配置的任何内容。
 function emptyUserConfig(): Record<string, unknown> {
     const locked = lockedChannelBaseUrls()[0] || "https://moai.wiki";
     return {
        ...defaultConfig,
        channels: [{ id: "default", name: "默认渠道", baseUrl: locked, apiKey: "", apiFormat: "openai", models: [] }],
        model: "",
        imageModel: "",
        videoModel: "",
        textModel: "",
        audioModel: "",
        models: [],
        imageModels: [],
        videoModels: [],
        textModels: [],
        audioModels: [],
    };
}

export async function readUserConfig(userId: string): Promise<SharedConfigRecord> {
    await ensureSchema();
    await ensureUserConfigSchema();
    const db = pool();
    // 普通用户完全读自己那份（config + webdav），不碰全局，看不到 admin 的任何配置。
    const userRow = await db.query<{ config_json: Record<string, unknown>; webdav_json: Record<string, unknown> }>(
        "SELECT config_json, webdav_json FROM user_configs WHERE user_id = $1 LIMIT 1",
        [userId],
    );
    const row = userRow.rows[0];
    // 存过就用自己的；没存过给空白默认（绝不用全局配置当模板，避免泄露 admin 的渠道/key）。
    const base = row?.config_json ? { ...defaultConfig, ...row.config_json } : emptyUserConfig();
    return {
        config: enforceLockedBaseUrl(base),
        webdav: { ...defaultWebdavConfig, ...(row?.webdav_json || {}) },
    };
}

export async function writeUserConfig(userId: string, config: Record<string, unknown>, webdav?: Record<string, unknown>) {
    await ensureSchema();
    await ensureUserConfigSchema();
    const db = pool();
    // 保存前强制把所有渠道 baseUrl 锁成中转地址，丢弃用户对 URL 的任何改动（绕过前端也无效）。其余（key/模型/webdav）全是用户自己的。
    const safeConfig = enforceLockedBaseUrl(config);
    const safeWebdav = { ...defaultWebdavConfig, ...(webdav || {}) };
    await db.query(
        `
        INSERT INTO user_configs (user_id, config_json, webdav_json, updated_at)
        VALUES ($1, $2::jsonb, $3::jsonb, NOW())
        ON CONFLICT (user_id) DO UPDATE SET config_json = EXCLUDED.config_json, webdav_json = EXCLUDED.webdav_json, updated_at = NOW()
        `,
        [userId, JSON.stringify(safeConfig), JSON.stringify(safeWebdav)],
    );
    return { config: safeConfig, webdav: safeWebdav };
}
