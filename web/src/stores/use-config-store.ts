import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";

export type ApiCallFormat = "openai" | "gemini" | "minimax" | "sd";
export type ApiFormatMode = "auto" | "manual";
export type ImageResponseFormat = "url" | "b64_json";
export type ReferenceImageRequestFormat = "form-data" | "json";
export type ModelCapability = "image" | "video" | "text" | "audio" | "file";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    apiFormatMode: ApiFormatMode;
    imageResponseFormat: ImageResponseFormat;
    referenceImageRequestFormat: ReferenceImageRequestFormat;
    supportsWorkflowId: boolean;
    models: ChannelModel[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    imageResponseFormat: ImageResponseFormat;
    referenceImageRequestFormat: ReferenceImageRequestFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    fileModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    videoWorkflowId: string;
    supportsWorkflowId: boolean;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    resolution: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    proxyEnabled: boolean;
    proxyUrl: string;
    nodeRegenerateBehavior: "new-node" | "overwrite";
    autoFocusOnSelect: boolean;
};

export type WebdavSyncConfig = {
    enabled: boolean;
    uploadGeneratedResources: boolean;
    storageMode: "local" | "webdav" | "local+webdav";
    url: string;
    username: string;
    password: string;
    directory: string;
    publicUrlPrefix: string;
    passwordConfigured?: boolean;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "local-proxy" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export type ChannelCredentialsImportResult = {
    status: "created" | "updated" | "missing-base-url" | "invalid-base-url";
    channelName?: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const MINIMAX_BASE_URL = "https://api.minimaxi.com";
const SD_BASE_URL = "https://api.meaicc.com";
export const LOCAL_PROXY_PACKAGE = "@basketikun/canvas-proxy";
export const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:23210";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    imageResponseFormat: "url",
    referenceImageRequestFormat: "json",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            apiFormatMode: "auto",
            imageResponseFormat: "url",
            referenceImageRequestFormat: "json",
            supportsWorkflowId: false,
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    fileModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    videoWorkflowId: "none",
    supportsWorkflowId: false,
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "reference",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "auto",
    resolution: "1K",
    size: "auto",
    background: "",
    count: "1",
    canvasImageCount: "3",
    proxyEnabled: false,
    proxyUrl: DEFAULT_LOCAL_PROXY_URL,
    nodeRegenerateBehavior: "overwrite",
    autoFocusOnSelect: false,
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    enabled: false,
    uploadGeneratedResources: false,
    storageMode: "local+webdav",
    url: "",
    username: "",
    password: "",
    directory: "images",
    publicUrlPrefix: "",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    configLoaded: boolean;
    canManageConfig: boolean;
    canManageUrl: boolean;
    lockedBaseUrl: string;
    lockedBaseUrls: string[];
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    replaceSharedConfig: (payload: { config: AiConfig; webdav: WebdavSyncConfig; canManage: boolean; canManageUrl?: boolean; lockedBaseUrl?: string; lockedBaseUrls?: string[] }) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo", "minimax_h3", "minimax-h3"];
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : capability === "file" ? config.fileModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : capability === "file" ? defaultConfig.fileModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const match = findChannelModel(config, model);
    return Boolean(match && match.channel.baseUrl.trim() && match.channel.apiKey.trim());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            configLoaded: false,
            canManageConfig: false,
            canManageUrl: false,
            lockedBaseUrl: "",
            lockedBaseUrls: [],
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            importChannelCredentials: (input) => {
                const currentConfig = get().config;
                const result = upsertChannelCredentials(currentConfig, input);
                if (result.config !== currentConfig) set({ config: result.config });
                return { status: result.status, channelName: result.channelName };
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            replaceSharedConfig: ({ config, webdav, canManage, canManageUrl, lockedBaseUrl, lockedBaseUrls }) =>
                set({
                    config: normalizeConfig({ ...defaultConfig, ...config }),
                    webdav: { ...defaultWebdavSyncConfig, ...webdav },
                    configLoaded: true,
                    canManageConfig: canManage,
                    canManageUrl: Boolean(canManageUrl),
                    lockedBaseUrl: lockedBaseUrl || "",
                    lockedBaseUrls: lockedBaseUrls || [],
                }),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => {
                if (!get().canManageConfig) return;
                set({ isConfigOpen: true, shouldPromptContinue, configTab });
            },
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: () => ({}),
            merge: (_, current) => ({
                ...current,
                config: defaultConfig,
                webdav: defaultWebdavSyncConfig,
                configLoaded: false,
                canManageConfig: false,
                canManageUrl: false,
                lockedBaseUrl: "",
                lockedBaseUrls: [],
            }),
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        result.push({ name, capability, script });
    }
    return result;
}

const GEMINI_MODEL_NAME_PATTERN = /(^|[/:._-])gemini(?:$|[/:._-])/i;
const OPENAI_MODEL_NAME_PATTERN = /(^|[/:._-])(?:openai|gpt|dall[-_]?e|dalle|grok|o[1-9])(?:$|[/:._-])/i;
const MINIMAX_MODEL_NAME_PATTERN = /(^|[/:._-])minimax(?:$|[/:._-])/i;
const SD_MODEL_NAME_PATTERN = /(^|[/:._-])(?:sd-2|seedance)(?:$|[/:._-])/i;

export function inferModelApiFormat(modelName: string): ApiCallFormat | undefined {
    const value = modelName.trim();
    if (!value) return undefined;
    if (GEMINI_MODEL_NAME_PATTERN.test(value)) return "gemini";
    if (MINIMAX_MODEL_NAME_PATTERN.test(value)) return "minimax";
    if (SD_MODEL_NAME_PATTERN.test(value)) return "sd";
    if (OPENAI_MODEL_NAME_PATTERN.test(value)) return "openai";
    return undefined;
}

export function inferChannelApiFormat(models: Array<string | ChannelModel> | undefined): ApiCallFormat | undefined {
    const formats = new Set<ApiCallFormat>();
    for (const item of models || []) {
        const format = inferModelApiFormat(typeof item === "string" ? item : item?.name || "");
        if (format) formats.add(format);
    }
    return formats.size === 1 ? formats.values().next().value : undefined;
}

export function incompatibleModelNames(models: ChannelModel[], apiFormat: ApiCallFormat) {
    return models.filter((model) => {
        const inferred = inferModelApiFormat(model.name);
        return Boolean(inferred && inferred !== apiFormat);
    }).map((model) => model.name);
}

function normalizeImageResponseFormat(value: unknown): ImageResponseFormat {
    return value === "b64_json" ? "b64_json" : "url";
}

function normalizeReferenceImageRequestFormat(value: unknown): ReferenceImageRequestFormat {
    return value === "form-data" ? "form-data" : "json";
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const models = normalizeChannelModels(channel?.models);
    const hasMode = Boolean(channel && Object.prototype.hasOwnProperty.call(channel, "apiFormatMode"));
    const apiFormatMode: ApiFormatMode = channel?.apiFormatMode === "manual" || (!hasMode && Boolean(channel?.id)) ? "manual" : "auto";
    const configuredFormat = normalizeApiFormat(channel?.apiFormat);
    const apiFormat = apiFormatMode === "auto" ? inferChannelApiFormat(models) || configuredFormat : configuredFormat;
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        apiFormatMode,
        imageResponseFormat: normalizeImageResponseFormat(channel?.imageResponseFormat),
        referenceImageRequestFormat: apiFormat === "sd" ? "json" : normalizeReferenceImageRequestFormat(channel?.referenceImageRequestFormat),
        supportsWorkflowId: channel?.supportsWorkflowId === true,
        models,
    };
}

export function upsertChannelCredentials(
    config: AiConfig,
    input: { baseUrl?: string | null; apiKey?: string | null },
): ChannelCredentialsImportResult & { config: AiConfig } {
    const rawBaseUrl = input.baseUrl?.trim() || "";
    if (!rawBaseUrl) return { status: "missing-base-url", config };
    if (!isHttpBaseUrl(rawBaseUrl)) return { status: "invalid-base-url", config };

    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl);
    const apiKey = input.apiKey?.trim() || "";
    const matchingIndex = config.channels.findIndex((channel) => normalizedBaseUrlKey(channel.baseUrl) === normalizedBaseUrlKey(baseUrl));

    if (matchingIndex >= 0) {
        const existing = config.channels[matchingIndex];
        if (existing.baseUrl === baseUrl && (!apiKey || existing.apiKey === apiKey)) {
            return { status: "updated", channelName: existing.name, config };
        }
        const updated = { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) };
        const channels = config.channels.map((channel, index) => (index === matchingIndex ? updated : channel));
        return { status: "updated", channelName: existing.name, config: { ...config, channels } };
    }

    const channel = createModelChannel({
        name: importedChannelName(baseUrl),
        baseUrl,
        apiKey,
        apiFormat: "openai",
        models: [],
    });
    return { status: "created", channelName: channel.name, config: { ...config, channels: [...config.channels, channel] } };
}

function isHttpBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function normalizedBaseUrlKey(baseUrl: string) {
    try {
        return stripTrailingApiVersion(normalizeImportedBaseUrl(baseUrl));
    } catch {
        return stripTrailingApiVersion(baseUrl.trim().replace(/\/+$/, ""));
    }
}

function normalizeImportedBaseUrl(baseUrl: string) {
    const url = new URL(baseUrl.trim());
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function stripTrailingApiVersion(baseUrl: string) {
    return baseUrl.replace(/\/v1$/i, "");
}

function importedChannelName(baseUrl: string) {
    const hostname = new URL(baseUrl).hostname;
    return hostname.replace(/^(?:www|api)\./i, "") || i18n.t("config.channels.newName");
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function assertModelAvailable(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = modelOptionName(value);
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((entry) => entry.name === model));
    if (!channel?.models.some((entry) => entry.name === model)) throw new Error("所选模型或渠道已不可用，请重新选择模型");
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        imageResponseFormat: channel.imageResponseFormat,
        referenceImageRequestFormat: channel.referenceImageRequestFormat,
        supportsWorkflowId: channel.supportsWorkflowId,
    };
}

function normalizeConfig(config: AiConfig) {
    const channels = normalizeChannels(config);
    const normalized: AiConfig = {
        ...config,
        channels,
        videoWorkflowId: config.videoWorkflowId || defaultConfig.videoWorkflowId,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
        imageResponseFormat: normalizeImageResponseFormat(channels[0]?.imageResponseFormat),
        referenceImageRequestFormat: normalizeReferenceImageRequestFormat(channels[0]?.referenceImageRequestFormat),
    };
    return {
        ...normalized,
        imageModel: normalizeDefaultModel(config.imageModel, selectableModelsByCapability(normalized, "image")),
        videoModel: normalizeDefaultModel(config.videoModel, selectableModelsByCapability(normalized, "video")),
        textModel: normalizeDefaultModel(config.textModel, selectableModelsByCapability(normalized, "text")),
        audioModel: normalizeDefaultModel(config.audioModel, selectableModelsByCapability(normalized, "audio")),
        fileModel: normalizeDefaultModel(config.fileModel, selectableModelsByCapability(normalized, "file")),
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel, config.fileModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    if (apiFormat === "minimax") return MINIMAX_BASE_URL;
    if (apiFormat === "sd") return SD_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" || apiFormat === "minimax" || apiFormat === "sd" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

function normalizeDefaultModel(value: string, options: string[]) {
    return value || options[0] || "";
}

export function buildAiProxyUrl(targetUrl: string) {
    if (useConfigStore.getState().config.proxyEnabled) return withLocalProxy(targetUrl);
    return `/api/ai-proxy?url=${encodeURIComponent(targetUrl)}`;
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

export function normalizeLocalProxyUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Prefix an outgoing request with the local forwarding proxy so the browser is not blocked by CORS. */
export function withLocalProxy(url: string) {
    const { proxyEnabled, proxyUrl } = useConfigStore.getState().config;
    if (!proxyEnabled || !/^https?:\/\//i.test(url)) return url;
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base || url.startsWith(`${base}/`)) return url;
    return `${base}/${url}`;
}
