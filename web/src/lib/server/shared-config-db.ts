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
    modelCosts: [
        { model: "default::gpt-image-2", credits: 1 },
        { model: "default::grok-imagine-video", credits: 1 },
        { model: "default::gpt-5.5", credits: 0 },
        { model: "default::gpt-4o-mini-tts", credits: 1 },
    ],
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
