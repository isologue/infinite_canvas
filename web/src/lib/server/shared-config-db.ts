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
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

// 普通用户渠道 baseUrl 的默认/锁定值，可用 env 配置。
export function lockedChannelBaseUrl() {
    return process.env.LOCKED_CHANNEL_BASE_URL?.trim() || process.env.NEXT_PUBLIC_LOCKED_CHANNEL_BASE_URL?.trim() || "https://moai.wiki";
}

// 普通用户渠道只锁 baseUrl，apiKey 归用户自己管：
// - 和全局同名的渠道 → 用全局 baseUrl
// - 用户自建的渠道（全局没有）→ 一律锁成 env 默认中转地址，用户改不了
function enforceGlobalChannelSecrets(userConfig: Record<string, unknown>, globalConfig: Record<string, unknown>) {
    const locked = lockedChannelBaseUrl();
    const globalChannels = Array.isArray(globalConfig.channels) ? (globalConfig.channels as ChannelLike[]) : [];
    const globalById = new Map(globalChannels.filter((c) => typeof c.id === "string").map((c) => [c.id as string, c]));
    const userChannels = Array.isArray(userConfig.channels) ? (userConfig.channels as ChannelLike[]) : [];
    const mergedChannels = userChannels.map((channel) => {
        const globalMatch = channel.id ? globalById.get(channel.id as string) : undefined;
        // 只回填 baseUrl（超管控制或锁定中转地址）；apiKey 保留用户自己填的。
        return {
            ...channel,
            baseUrl: globalMatch ? globalMatch.baseUrl : locked,
        };
    });
    const result: Record<string, unknown> = { ...userConfig, channels: mergedChannels };
    // 顶层 baseUrl 是 channels[0] 的镜像。
    result.baseUrl = mergedChannels[0]?.baseUrl ?? locked;
    return result;
}

export async function readUserConfig(userId: string): Promise<SharedConfigRecord> {
    await ensureSchema();
    await ensureUserConfigSchema();
    const db = pool();
    const [globalRecord, userRow] = await Promise.all([
        readSharedConfig(),
        db.query<{ config_json: Record<string, unknown> }>("SELECT config_json FROM user_configs WHERE user_id = $1 LIMIT 1", [userId]),
    ]);
    // 用户没存过配置：给一份默认（渠道 URL/key 用全局的）。
    const base = userRow.rows[0]?.config_json || { ...defaultConfig, channels: (globalRecord.config as { channels?: unknown }).channels };
    return {
        config: enforceGlobalChannelSecrets({ ...defaultConfig, ...base }, globalRecord.config),
        webdav: globalRecord.webdav,
    };
}

export async function writeUserConfig(userId: string, config: Record<string, unknown>) {
    await ensureSchema();
    await ensureUserConfigSchema();
    const db = pool();
    const globalRecord = await readSharedConfig();
    // 保存前强制回填全局渠道 URL/key，丢弃用户提交里对这两项的任何改动（绕过前端也无效）。
    const safeConfig = enforceGlobalChannelSecrets(config, globalRecord.config);
    await db.query(
        `
        INSERT INTO user_configs (user_id, config_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (user_id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = NOW()
        `,
        [userId, JSON.stringify(safeConfig)],
    );
    return { config: safeConfig, webdav: globalRecord.webdav };
}
