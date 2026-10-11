import axios from "axios";
import { nanoid } from "nanoid";

import { dataUrlToFile } from "@/lib/image-utils";
import { ensurePublicMediaUrl, getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { ensurePublicImageUrl, imageToDataUrl } from "@/services/image-storage";
import { buildAiErrorResponseResult, generationDurationSeconds, prepareAiLogValue, reportAiCall } from "@/services/ai-call-log";
import { buildAiProxyUrl, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; progress?: number | string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type MiniMaxVideoResponse = { task_id?: string; id?: string; status?: string; progress?: number | string; fail_reason?: string; error?: { message?: string } | string; url?: string; video_url?: string; result_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };

function boolConfig(value: string | undefined, fallback: boolean) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "minimax" | "plugin"; model: string; createdAt: number; logModel?: string; logParams?: unknown; logReported?: boolean };
export type VideoGenerationTaskState = { status: "pending"; progress?: number } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string; responseResult?: unknown };
type VideoGenerationTaskHandle = Pick<VideoGenerationTask, "id" | "provider" | "model">;
type CaptureRequestParams = (params: unknown) => void;

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildAiProxyUrl(buildApiUrl(config.baseUrl, path));
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

// 视频任务结束时上报一条 AI 调用日志（每个任务只报一次）。函数名沿用以兼容调用方。
export async function settleVideoTaskCredits(task: VideoGenerationTask, status: "success" | "failed", extra?: { errorMessage?: string; result?: unknown }) {
    if (!task.logReported) {
        task.logReported = true;
        void reportAiCall({
            kind: "video",
            model: task.logModel || task.model,
            status,
            reason: `video generation: ${task.logModel || task.model}`,
            durationSeconds: generationDurationSeconds(task.createdAt),
            requestParams: task.logParams,
            responseResult: extra?.result,
            errorMessage: status === "failed" ? extra?.errorMessage : undefined,
        });
    }
}

// onStored（可选）：调用方在拿到生成结果后把它存进存储并返回 storageKey 等摘要，
// 用于让日志带上 storageKey 以便预览。画布页会传它；不传则日志不含 storageKey（行为同以前）。
export async function requestVideoGeneration(
    config: AiConfig,
    prompt: string,
    references: ReferenceImage[] = [],
    videoReferences: ReferenceVideo[] = [],
    audioReferences: ReferenceAudio[] = [],
    options?: RequestOptions,
    onStored?: (result: VideoGenerationResult) => Promise<{ storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string; durationMs?: number }>,
): Promise<VideoGenerationResult> {
    let task: VideoGenerationTask | null = null;
    try {
        task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
        const delayMs = 5000;
        for (;;) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const state = await pollVideoGenerationTask(config, task, options);
            if (state.status === "completed") {
                // 若调用方提供了 onStored，先存储拿到 storageKey，再让日志带上它。存储只在此发生一次。
                const stored = onStored ? await onStored(state.result).catch(() => undefined) : undefined;
                await settleVideoTaskCredits(task, "success", stored ? { result: stored } : undefined);
                return state.result;
            }
            if (state.status === "failed") throw videoResponseError(state.error, state.responseResult);
            await delay(delayMs, options?.signal);
        }
    } catch (error) {
        if (task) await settleVideoTaskCredits(task, "failed", { errorMessage: error instanceof Error ? error.message : String(error), result: buildAiErrorResponseResult(error) });
        throw error;
    }
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const createdAt = Date.now();
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const logExtras = {
        createdAt,
        logModel: modelOptionName(selectedModel),
    };
    let requestParams: unknown;
    const captureRequestParams: CaptureRequestParams = (params) => { requestParams = prepareAiLogValue(params); };
    const attachLog = (task: VideoGenerationTaskHandle): VideoGenerationTask => ({ ...task, ...logExtras, logParams: requestParams });
    try {
        const script = resolveModelScript(config, selectedModel);
        if (script) return attachLog(await createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options));
        assertVideoConfig(requestConfig, requestConfig.model);
        if (requestConfig.apiFormat === "minimax") {
            return attachLog(await createMiniMaxVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options, captureRequestParams));
        }
        return attachLog(await createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options, captureRequestParams));
    } catch (error) {
        void reportAiCall({
            kind: "video",
            model: logExtras.logModel,
            status: "failed",
            reason: `video generation: ${logExtras.logModel}`,
            durationSeconds: generationDurationSeconds(createdAt),
            requestParams,
            responseResult: buildAiErrorResponseResult(error),
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: "插件视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    return task.provider === "minimax" ? pollMiniMaxTask(requestConfig, task, options) : pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTaskHandle> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

export async function storeGeneratedVideo(result: VideoGenerationResult, title = ""): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video", { title, source: "generated" });
    if (result.url) return uploadMediaFile(result.url, "video", { title, source: "generated" });
    throw new Error("视频接口没有返回可播放的视频");
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, captureRequestParams?: CaptureRequestParams): Promise<VideoGenerationTaskHandle> {
    if (config.referenceImageRequestFormat === "json") {
        const seconds = normalizeVideoSeconds(config.videoSeconds);
        const images = await Promise.all(references.slice(0, 7).map(ensurePublicImageUrl));
        const referenceVideos = await Promise.all(videoReferences.slice(0, 3).map(ensurePublicMediaUrl));
        const referenceAudios = await Promise.all(audioReferences.slice(0, 3).map(ensurePublicMediaUrl));
        const size = normalizeVideoSize(config.size);
        const body = {
            model: modelOptionName(model),
            prompt,
            ...(images.length ? { images } : {}),
            ...(referenceVideos.length ? { reference_videos: referenceVideos } : {}),
            ...(referenceAudios.length ? { reference_audios: referenceAudios } : {}),
            ...(size ? { size } : {}),
            aspect_ratio: normalizeVideoAspectRatio(config.size),
            duration: Number(seconds),
            seconds,
            n: 1,
        };
        captureRequestParams?.(body);
        try {
            const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
            if (!created.id) throw new Error("视频接口没有返回任务 ID");
            return { id: created.id, provider: "openai", model };
        } catch (error) {
            throw videoResponseError(readAxiosError(error, "视频任务创建失败"), buildAiErrorResponseResult(error));
        }
    }
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("aspect_ratio", normalizeVideoAspectRatio(config.size));
    const seconds = normalizeVideoSeconds(config.videoSeconds);
    body.append("seconds", seconds);
    body.append("duration", seconds);
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    const videoFiles = await Promise.all(videoReferences.slice(0, 3).map((video) => referenceMediaFile(video.storageKey, video.url, video.name, video.type)));
    videoFiles.forEach((file) => body.append("reference_videos", file));
    const audioFiles = await Promise.all(audioReferences.slice(0, 3).map((audio) => referenceMediaFile(audio.storageKey, audio.url, audio.name, audio.type)));
    audioFiles.forEach((file) => body.append("reference_audios", file));
    captureRequestParams?.(formDataRequestParams(body));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "视频任务创建失败"), buildAiErrorResponseResult(error));
    }
}

function formDataRequestParams(formData: FormData) {
    const params: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
        if (!(key in params)) params[key] = value;
        else if (Array.isArray(params[key])) (params[key] as unknown[]).push(value);
        else params[key] = [params[key], value];
    }
    return params;
}

async function createMiniMaxVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, captureRequestParams?: CaptureRequestParams): Promise<VideoGenerationTaskHandle> {
    const workflowId = resolveMiniMaxWorkflow(config.videoWorkflowId, references.length, videoReferences.length, audioReferences.length);
    const seconds = String(Math.max(1, Math.min(15, Number(normalizeVideoSeconds(config.videoSeconds)))));
    if (config.referenceImageRequestFormat === "json") {
        const body = {
            model: modelOptionName(model),
            prompt,
            seconds,
            workflow_id: workflowId,
            size: normalizeMiniMaxSize(config.size, config.vquality),
            ...(references.length ? { images: await Promise.all(references.slice(0, 9).map(ensurePublicImageUrl)) } : {}),
            ...(videoReferences.length ? { reference_videos: await Promise.all(videoReferences.slice(0, 3).map(ensurePublicMediaUrl)) } : {}),
            ...(audioReferences.length ? { reference_audios: await Promise.all(audioReferences.slice(0, 3).map(ensurePublicMediaUrl)) } : {}),
        };
        captureRequestParams?.(body);
        try {
            const response = await axios.post<MiniMaxVideoResponse | { data?: MiniMaxVideoResponse }>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
            const created = unwrapMiniMaxResponse(response.data);
            const id = created.task_id || created.id;
            if (!id) throw new Error("MiniMax H3 视频接口没有返回任务 ID");
            return { id, provider: "minimax", model };
        } catch (error) {
            throw videoResponseError(readAxiosError(error, "MiniMax H3 视频任务创建失败"), buildAiErrorResponseResult(error));
        }
    }
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", seconds);
    body.append("workflow_id", workflowId);
    body.append("size", normalizeMiniMaxSize(config.size, config.vquality));
    const imageFiles = await Promise.all(references.slice(0, 9).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    imageFiles.forEach((file) => body.append("images", file));
    const videoFiles = await Promise.all(videoReferences.slice(0, 3).map((video) => referenceMediaFile(video.storageKey, video.url, video.name, video.type)));
    videoFiles.forEach((file) => body.append("reference_videos", file));
    const audioFiles = await Promise.all(audioReferences.slice(0, 3).map((audio) => referenceMediaFile(audio.storageKey, audio.url, audio.name, audio.type)));
    audioFiles.forEach((file) => body.append("reference_audios", file));
    captureRequestParams?.(formDataRequestParams(body));
    try {
        const response = await axios.post<MiniMaxVideoResponse | { data?: MiniMaxVideoResponse }>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal });
        const created = unwrapMiniMaxResponse(response.data);
        const id = created.task_id || created.id;
        if (!id) throw new Error("MiniMax H3 接口没有返回任务 ID");
        return { id, provider: "minimax", model };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "MiniMax H3 视频任务创建失败"), buildAiErrorResponseResult(error));
    }
}

async function pollMiniMaxTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const response = await axios.get<MiniMaxVideoResponse | { data?: MiniMaxVideoResponse }>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal });
        const state = unwrapMiniMaxResponse(response.data);
        const url = videoResultUrl(state as VideoResponse);
        if (url) return { status: "completed", result: { url, mimeType: "video/mp4" } };
        if (state.status === "completed" || state.status === "succeeded") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: readApiErrorMessage(state.fail_reason || state.error) || `MiniMax H3 视频生成${state.status === "expired" ? "超时" : "失败"}`, responseResult: state };
        return { status: "pending", progress: normalizeProgress(state.progress) };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "MiniMax H3 视频任务查询失败"), buildAiErrorResponseResult(error));
    }
}

async function referenceMediaFile(storageKey: string | undefined, url: string | undefined, name: string, type: string) {
    const blob = storageKey ? await getMediaBlob(storageKey) : url ? await (await fetch(url)).blob() : null;
    if (!blob) throw new Error(`读取参考素材失败：${name}`);
    return new File([blob], name || "reference", { type: blob.type || type || "application/octet-stream" });
}

function resolveMiniMaxWorkflow(value: string, imageCount: number, videoCount: number, audioCount: number) {
    if (value && value !== "auto") return value;
    if (videoCount || audioCount || imageCount > 2) return "multi-reference";
    if (imageCount) return "fl2v";
    return "text-to-video";
}

function normalizeMiniMaxSize(value: string, quality: string) {
    if (/^\d+x\d+$/i.test(value || "")) return value;
    const ratio = normalizeVideoAspectRatio(value);
    const level = Number(String(quality).replace(/p$/i, "")) || 768;
    const sizes: Record<string, Record<string, string>> = {
        "16:9": { "480": "864x480", "720": "1376x768", "768": "1376x768", "1080": "1920x1088" },
        "9:16": { "480": "480x864", "720": "768x1376", "768": "768x1376", "1080": "1088x1920" },
        "1:1": { "480": "640x640", "720": "1024x1024", "768": "1024x1024", "1080": "1440x1440" },
        "2:3": { "480": "544x800", "720": "832x1248", "768": "832x1248", "1080": "1184x1760" },
        "3:2": { "480": "800x544", "720": "1248x832", "768": "1248x832", "1080": "1760x1184" },
        "3:4": { "480": "576x736", "720": "896x1184", "768": "896x1184", "1080": "1248x1664" },
        "4:3": { "480": "736x576", "720": "1184x896", "768": "1184x896", "1080": "1664x1248" },
        "21:9": { "480": "992x416", "720": "1568x672", "768": "1568x672", "1080": "2208x960" },
    };
    return sizes[ratio]?.[String(level)] || sizes[ratio]?.["768"] || "1376x768";
}

function unwrapMiniMaxResponse(payload: MiniMaxVideoResponse | { data?: MiniMaxVideoResponse }) {
    if (payload && typeof payload === "object" && "data" in payload && payload.data) return payload.data;
    return payload as MiniMaxVideoResponse;
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: { url, mimeType: "video/mp4" } };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || "视频生成失败", responseResult: video };
        return { status: "pending", progress: normalizeProgress(video.progress) };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "视频任务查询失败"), buildAiErrorResponseResult(error));
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoAspectRatio(value: string) {
    if (/^\d+:\d+$/.test(value)) return value;
    const [width, height] = (normalizeVideoSize(value) || "1280x720").split("x").map(Number);
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    if (!payload) throw new Error("接口没有返回视频任务");
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (!isSuccessCode(payload.code)) throw videoResponseError(readApiErrorMessage(payload) || "请求失败", payload);
        return payload.data !== undefined && payload.data !== null ? payload.data : (payload as VideoResponse);
    }
    return payload as VideoResponse;
}

function isSuccessCode(value: unknown) {
    return value === 0 || (typeof value === "string" && ["0", "success", "ok"].includes(value.trim().toLowerCase()));
}

function videoResponseError(message: string, responseResult?: unknown) {
    const error = new Error(message) as Error & { responseResult?: unknown };
    if (responseResult !== undefined) error.responseResult = responseResult;
    return error;
}

function videoResultUrl(payload: VideoResponse) {
    const urls: unknown[] = [];
    const visit = (value: unknown, depth = 0) => {
        if (!value || depth > 3 || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        urls.push(record.video_url, record.result_url, record.url, (record.content as Record<string, unknown> | undefined)?.video_url, (record.content as Record<string, unknown> | undefined)?.url);
        visit(record.data, depth + 1);
    };
    visit(payload);
    return urls.find((url): url is string => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
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
    // error 可能是字符串或含 message 的对象
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
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob, url?: string) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number | string; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number | string; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    const responseResult = url ? { stage: "video_download", url, data: payload } : payload;
    if (payload.code !== undefined && !isSuccessCode(payload.code)) throw videoResponseError(readApiErrorMessage(payload) || "视频下载失败", responseResult);
    if (payload.error?.message) throw videoResponseError(readApiErrorMessage(payload.error.message) || payload.error.message, responseResult);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function normalizeProgress(value: unknown) {
    if (typeof value === "string") {
        const text = value.trim();
        if (!text) return undefined;
        const parsed = Number(text.replace(/%$/, ""));
        if (!Number.isFinite(parsed)) return undefined;
        value = parsed;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const percent = value >= 0 && value <= 1 ? value * 100 : value;
    return Math.round(Math.max(0, Math.min(100, percent)));
}
