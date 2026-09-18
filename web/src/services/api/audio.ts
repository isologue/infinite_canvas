import axios from "axios";

import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { generationDurationSeconds, reportAiCall } from "@/services/ai-call-log";
import { buildAiProxyUrl, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";

type RequestOptions = { signal?: AbortSignal };

function aiApiUrl(config: AiConfig, path: string) {
    return buildAiProxyUrl(buildApiUrl(config.baseUrl, path));
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob | string> {
    const startedAt = Date.now();
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    const script = resolveModelScript(config, config.model || config.audioModel);
    if (script) {
        if (!model) throw new Error("请先配置音频模型");
        if (!requestConfig.baseUrl.trim()) throw new Error("请先配置 Base URL");
        if (!requestConfig.apiKey.trim()) throw new Error("请先配置 API Key");
        try {
            const result = await runModelPlugin({
                capability: "audio",
                script,
                config: requestConfig,
                prompt,
                params: { voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: normalizeAudioSpeedValue(config.audioSpeed), instructions: config.audioInstructions.trim() },
                signal: options?.signal,
            });
            return await audioPluginResult(result, format);
        } catch (error) {
            throw new Error(readAxiosError(error, "音频生成失败"));
        }
    }
    assertAudioConfig(requestConfig, model);
    const instructions = config.audioInstructions.trim();
    const selectedModel = config.model || config.audioModel;
    try {
        const response = await axios.post<Blob>(
            aiApiUrl(requestConfig, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
        );
        const result = await audioResponseResult(response.data, format);
        void reportAiCall({
            kind: "audio",
            model: modelOptionName(selectedModel),
            status: "success",
            reason: `audio generation: ${modelOptionName(selectedModel)}`,
            durationSeconds: generationDurationSeconds(startedAt),
            requestParams: { model, voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: Number(normalizeAudioSpeedValue(config.audioSpeed)), promptLength: prompt.length },
            responseResult: typeof result === "string" ? (/^https?:\/\//i.test(result) ? { url: result } : { data: "base64" }) : { bytes: result.size, mimeType: result.type },
        });
        return result;
    } catch (error) {
        const messageText = readAxiosError(error, "audio generation failed");
        void reportAiCall({
            kind: "audio",
            model: modelOptionName(selectedModel),
            status: "failed",
            reason: `audio generation: ${modelOptionName(selectedModel)}`,
            durationSeconds: generationDurationSeconds(startedAt),
            requestParams: { model, voice: normalizeAudioVoiceValue(config.audioVoice), format, promptLength: prompt.length },
            errorMessage: messageText,
        });
        throw new Error(messageText);
    }
}

async function audioPluginResult(result: unknown, format: string): Promise<Blob | string> {
    if (result instanceof Blob) return audioResponseResult(result, format);
    const source = audioResultSource(result);
    if (!source) throw new Error("模型调用脚本没有返回音频");
    if (/^https?:\/\//i.test(source)) return source;
    const url = source.startsWith("data:") ? source : `data:${audioMimeType(format)};base64,${source}`;
    const blob = await (await fetch(url)).blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(input: Blob | string, format = "mp3", title = ""): Promise<UploadedFile> {
    if (typeof input === "string") return uploadMediaFile(input, "audio", { title, source: "generated" });
    const blob = input;
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio", { title, source: "generated" });
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
}

async function audioResponseResult(blob: Blob, format: string): Promise<Blob | string> {
    if (!blob.type.includes("json")) return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        throw new Error("音频接口返回了无效 JSON");
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
    return audioPluginResult(payload, format);
}

function audioResultSource(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        for (const item of value) {
            const source = audioResultSource(item);
            if (source) return source;
        }
        return "";
    }
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of ["url", "audio_url", "result_url", "b64_json", "audio", "result", "data"]) {
        const source = audioResultSource(record[key]);
        if (source) return source;
    }
    return "";
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return `服务返回了 HTML 错误页面（${value.slice(0, 80)}...）`;
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        const statusMsg = statusMessage(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    if (status === 404) return "接口地址不存在（404），请检查 Base URL 和模型选择";
    if (status === 502) return "网关错误（502），接口服务暂时不可用，请稍后重试";
    if (status === 503) return "服务繁忙（503），请稍后重试";
    return status ? `请求失败（HTTP ${status}），请检查 Base URL 和 API Key 是否正确` : fallback;
}
