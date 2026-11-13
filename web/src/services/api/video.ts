import { assertModelAvailable } from "@/stores/use-config-store";
import { inferVideoRatio } from "@/lib/media-size";
import { resolveMediaUrl } from "@/services/file-storage";
import i18n from "@/i18n";
import { readFileAsDataUrl } from "@/lib/image-utils";
import axios from "axios";
import { nanoid } from "nanoid";

import { dataUrlToFile } from "@/lib/image-utils";
import { ensurePublicMediaUrl, getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { createPublicImageUrlResolver, imageToDataUrl } from "@/services/image-storage";
import { buildAiErrorResponseResult, generationDurationSeconds, prepareAiLogValue, reportAiCall } from "@/services/ai-call-log";
import { buildAiProxyUrl, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; progress?: number | string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type MiniMaxVideoResponse = { task_id?: string; id?: string; message?: string; status?: string; progress?: number | string; fail_reason?: string; error?: { message?: string } | string; url?: string; video_url?: string; result_url?: string; content?: { video_url?: string; url?: string } | null };
type SdVideoResponse = { task_id?: string; id?: string; object?: string; status?: string; progress?: number | string; created_at?: number; seconds?: number };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };

function boolConfig(value: string | undefined, fallback: boolean) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; responseResult?: unknown };
export type VideoGenerationTask = { id: string; provider: "openai" | "gemini" | "minimax" | "sd" | "plugin"; model: string; createdAt: number; logModel?: string; logParams?: unknown; logReported?: boolean };
export type VideoGenerationTaskState = { status: "pending"; progress?: number } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string; responseResult?: unknown };
type VideoGenerationTaskHandle = Pick<VideoGenerationTask, "id" | "provider" | "model">;
type CaptureRequestParams = (params: unknown) => void;

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

export function videoTaskPollInterval(task: Pick<VideoGenerationTask, "provider">) {
    return task.provider === "sd" ? 20_000 : 5_000;
}

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
export async function settleVideoTaskCredits(task: VideoGenerationTask, status: "success" | "failed", extra?: { errorMessage?: string; result?: unknown; upstreamDurationSeconds?: number; localProcessingDurationSeconds?: number }) {
    if (!task.logReported) {
        task.logReported = true;
        void reportAiCall({
            kind: "video",
            model: task.logModel || task.model,
            status,
            reason: `video generation: ${task.logModel || task.model}`,
            durationSeconds: generationDurationSeconds(task.createdAt),
            upstreamDurationSeconds: extra?.upstreamDurationSeconds,
            localProcessingDurationSeconds: extra?.localProcessingDurationSeconds,
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
        const delayMs = videoTaskPollInterval(task);
        for (;;) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const state = await pollVideoGenerationTask(config, task, options);
            if (state.status === "completed") {
                const resultReceivedAt = Date.now();
                // 若调用方提供了 onStored，先存储拿到 storageKey，再让日志带上它。存储只在此发生一次。
                let stored;
                try {
                    stored = onStored ? await onStored(state.result) : undefined;
                } catch (error) {
                    await settleVideoTaskCredits(task, "failed", {
                        errorMessage: error instanceof Error ? error.message : String(error),
                        result: { upstreamResponse: state.result.responseResult ?? null, localError: buildAiErrorResponseResult(error) },
                        upstreamDurationSeconds: generationDurationSeconds(task.createdAt, resultReceivedAt),
                        localProcessingDurationSeconds: generationDurationSeconds(resultReceivedAt),
                    });
                    throw error;
                }
                await settleVideoTaskCredits(task, "success", {
                    result: {
                        upstreamResponse: state.result.responseResult ?? null,
                        ...(stored ? { localResult: stored } : {}),
                    },
                    upstreamDurationSeconds: generationDurationSeconds(task.createdAt, resultReceivedAt),
                    ...(onStored ? { localProcessingDurationSeconds: generationDurationSeconds(resultReceivedAt) } : {}),
                });
                return state.result;
            }
            if (state.status === "failed") throw videoResponseError(state.error, state.responseResult);
            await delay(delayMs, options?.signal);
        }
    } catch (error) {
        if (task) await settleVideoTaskCredits(task, "failed", { errorMessage: error instanceof Error ? error.message : String(error), result: buildAiErrorResponseResult(error), upstreamDurationSeconds: generationDurationSeconds(task.createdAt) });
        throw error;
    }
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const createdAt = Date.now();
    const selectedModel = (config.model || config.videoModel).trim();
    assertModelAvailable(config, selectedModel);
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
        if (script) return attachLog(await createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, { ...options, videos: videoReferences, audios: audioReferences }));
        assertVideoConfig(requestConfig, requestConfig.model);
        if (requestConfig.apiFormat === "minimax") {
            return attachLog(await createMiniMaxVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options, captureRequestParams));
        }
        if (requestConfig.apiFormat === "sd") {
            return attachLog(await createSdVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options, captureRequestParams));
        }
        if (requestConfig.apiFormat === "gemini") return attachLog(await createGeminiVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options, captureRequestParams));
        return attachLog(await createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options, captureRequestParams));
    } catch (error) {
        void reportAiCall({
            kind: "video",
            model: logExtras.logModel,
            status: "failed",
            reason: `video generation: ${logExtras.logModel}`,
            durationSeconds: generationDurationSeconds(createdAt),
            upstreamDurationSeconds: generationDurationSeconds(createdAt),
            requestParams,
            responseResult: buildAiErrorResponseResult(error),
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    assertModelAvailable(config, config.model || task.model);
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: "插件视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "gemini") return pollGeminiVideoTask(requestConfig, task, options);
    if (task.provider === "minimax") return pollMiniMaxTask(requestConfig, task, options);
    if (task.provider === "sd") return pollSdVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTaskHandle> {
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
            videos: await Promise.all((options?.videos || []).map((item) => referenceMediaToFile(item, "ref.mp4", "invalidReferenceVideo", options))),
            audios: await Promise.all((options?.audios || []).map((item) => referenceMediaToFile(item, "ref.mp3", "invalidReferenceAudio", options))),
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: videoAspectRatio(config.size),
                mode: resolveVideoMode(config.videoMode, refs.length),
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

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, captureRequestParams?: CaptureRequestParams, requestFormat = config.referenceImageRequestFormat): Promise<VideoGenerationTaskHandle> {
    const resolvePublicImageUrl = createPublicImageUrlResolver();
    if (requestFormat === "json") {
        const seconds = normalizeVideoSeconds(config.videoSeconds);
        let images: string[];
        let referenceVideos: string[];
        let referenceAudios: string[];
        try {
            [images, referenceVideos, referenceAudios] = await Promise.all([
                Promise.all(references.slice(0, 7).map(resolvePublicImageUrl)),
                Promise.all(videoReferences.slice(0, 3).map(ensurePublicMediaUrl)),
                Promise.all(audioReferences.slice(0, 3).map(ensurePublicMediaUrl)),
            ]);
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            return createOpenAIVideoTask(config, model, prompt, references, videoReferences, audioReferences, options, captureRequestParams, "form-data");
        }
        const size = normalizeVideoSize(config.size);
        const body = {
            model: modelOptionName(model),
            prompt,
            ...(images.length ? { images } : {}),
            ...(config.videoMode === "frames" ? { mode: "frames", first_frame: images[0], last_frame: images[1] } : {}),
            ...(referenceVideos.length ? { reference_videos: referenceVideos } : {}),
            ...(referenceAudios.length ? { reference_audios: referenceAudios } : {}),
            ...(size ? { size } : {}),
            aspect_ratio: normalizeVideoAspectRatio(config.size),
            resolution: normalizeVideoResolution(config.vquality),
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
    body.append("resolution", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    if (config.videoMode === "frames") {
        body.append("mode", "frames");
        if (files[0]) body.append("first_frame", files[0]);
        if (files[1]) body.append("last_frame", files[1]);
    }
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

async function createMiniMaxVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, captureRequestParams?: CaptureRequestParams, requestFormat = config.referenceImageRequestFormat): Promise<VideoGenerationTaskHandle> {
    const resolvePublicImageUrl = createPublicImageUrlResolver();
    const quality = miniMaxModelResolution(model) || config.vquality;
    const highResolution = isMiniMaxHighResolution(quality);
    const workflowId = config.supportsWorkflowId ? resolveMiniMaxWorkflow(config.videoWorkflowId, references.length, videoReferences.length, audioReferences.length, highResolution) : "";
    const size = normalizeMiniMaxSize(config.size, quality);
    const aspectRatio = highResolution ? normalizeMiniMaxAspectRatio(config.size) : undefined;
    const seconds = String(Math.max(1, Math.min(15, Number(normalizeVideoSeconds(config.videoSeconds)))));
    if (requestFormat === "json") {
        let images: string[];
        let referenceVideos: string[];
        let referenceAudios: string[];
        try {
            [images, referenceVideos, referenceAudios] = await Promise.all([
                Promise.all(references.slice(0, 9).map(resolvePublicImageUrl)),
                Promise.all(videoReferences.slice(0, 3).map(ensurePublicMediaUrl)),
                Promise.all(audioReferences.slice(0, 3).map(ensurePublicMediaUrl)),
            ]);
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            return createMiniMaxVideoTask(config, model, prompt, references, videoReferences, audioReferences, options, captureRequestParams, "form-data");
        }
        const body = {
            model: modelOptionName(model),
            prompt,
            seconds,
            ...(workflowId ? { workflow_id: workflowId } : {}),
            size,
            ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
            ...(images.length ? { images } : {}),
            ...(referenceVideos.length ? { reference_videos: referenceVideos } : {}),
            ...(referenceAudios.length ? { reference_audios: referenceAudios } : {}),
        };
        captureRequestParams?.(body);
        try {
            const response = await axios.post<MiniMaxVideoResponse | { data?: MiniMaxVideoResponse }>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
            const created = unwrapMiniMaxResponse(response.data);
            const id = miniMaxTaskId(created);
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
    if (workflowId) body.append("workflow_id", workflowId);
    body.append("size", size);
    if (aspectRatio) body.append("aspect_ratio", aspectRatio);
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
        const id = miniMaxTaskId(created);
        if (!id) throw new Error("MiniMax H3 接口没有返回任务 ID");
        return { id, provider: "minimax", model };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "MiniMax H3 视频任务创建失败"), buildAiErrorResponseResult(error));
    }
}

async function createSdVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, captureRequestParams?: CaptureRequestParams): Promise<VideoGenerationTaskHandle> {
    const resolvePublicImageUrl = createPublicImageUrlResolver();
    try {
        const [images, videos, audios] = await Promise.all([
            Promise.all(references.slice(0, 9).map(resolvePublicImageUrl)),
            Promise.all(videoReferences.slice(0, 3).map(ensurePublicMediaUrl)),
            Promise.all(audioReferences.slice(0, 3).map(ensurePublicMediaUrl)),
        ]);
        const media = [
            ...images.map((url) => ({ type: "reference_image", url })),
            ...audios.map((url) => ({ type: "reference_voice", url })),
            ...videos.map((url) => ({ type: "reference_video", url })),
        ];
        const body = {
            model: modelOptionName(model),
            input: { prompt, ...(media.length ? { media } : {}) },
            parameters: {
                resolution: normalizeVideoResolution(config.vquality),
                ratio: normalizeSdVideoRatio(config.size),
                duration: Number(normalizeVideoSeconds(config.videoSeconds)),
            },
        };
        captureRequestParams?.(body);
        const created = (await axios.post<SdVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data;
        if (created.status?.toUpperCase().startsWith("FAILED")) throw videoResponseError(sdFailureMessage(created.status), created);
        const id = created.task_id || created.id;
        if (!id) throw new Error("SD 视频接口没有返回任务 ID");
        return { id, provider: "sd", model };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "SD 视频任务创建失败"), buildAiErrorResponseResult(error));
    }
}

async function pollMiniMaxTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const response = await axios.get<MiniMaxVideoResponse | { data?: MiniMaxVideoResponse }>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal });
        const rawResponse = response.data;
        const state = unwrapMiniMaxResponse(rawResponse);
        const url = videoResultUrl(state as VideoResponse);
        if (url) return { status: "completed", result: { url, mimeType: "video/mp4", responseResult: rawResponse } };
        if (state.status === "completed" || state.status === "succeeded") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data, mimeType: content.data.type || "video/mp4", responseResult: rawResponse } };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: readApiErrorMessage(state.fail_reason || state.error) || `MiniMax H3 视频生成${state.status === "expired" ? "超时" : "失败"}`, responseResult: rawResponse };
        return { status: "pending", progress: normalizeProgress(state.progress) };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "MiniMax H3 视频任务查询失败"), buildAiErrorResponseResult(error));
    }
}

async function pollSdVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = (await axios.get<SdVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        if (typeof state.object === "string" && isPublicMediaUrl(state.object)) return { status: "completed", result: { url: state.object, mimeType: "video/mp4" } };
        const status = state.status?.trim().toUpperCase() || "";
        if (status.startsWith("FAILED")) return { status: "failed", error: sdFailureMessage(state.status), responseResult: state };
        if (status === "SUCCEEDED") return { status: "failed", error: "SD 视频任务已完成，但没有返回视频地址", responseResult: state };
        return { status: "pending", progress: normalizeProgress(state.progress) };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, "SD 视频任务查询失败"), buildAiErrorResponseResult(error));
    }
}

async function referenceMediaFile(storageKey: string | undefined, url: string | undefined, name: string, type: string) {
    const blob = storageKey ? await getMediaBlob(storageKey) : url ? await (await fetch(url)).blob() : null;
    if (!blob) throw new Error(`读取参考素材失败：${name}`);
    return new File([blob], name || "reference", { type: blob.type || type || "application/octet-stream" });
}

function resolveMiniMaxWorkflow(value: string, imageCount: number, videoCount: number, audioCount: number, highResolution = false) {
    if (!value || value === "none") return "";
    const workflow = value && value !== "auto" ? value : videoCount || audioCount || imageCount > 2 ? "multi-reference" : imageCount ? "fl2v" : "text-to-video";
    if (highResolution) return ["cf-multi-reference", "cf-fl2v", "cf-mj"].includes(workflow) ? workflow : "cf-multi-reference";
    return workflow;
}

function normalizeMiniMaxSize(value: string, quality: string) {
    const resolution = String(quality).trim().toUpperCase();
    if (resolution === "2K" || resolution === "4K") return resolution;
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

function isMiniMaxHighResolution(value: string) {
    return /^(2K|4K)$/i.test(value.trim());
}

function miniMaxModelResolution(model: string) {
    const matched = model.match(/(?:^|[^a-z0-9])(480|768|1080)p?(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(2k|4k)(?:$|[^a-z0-9])/i);
    if (!matched) return undefined;
    return (matched[1] || matched[2]).toUpperCase();
}

function normalizeMiniMaxAspectRatio(value: string) {
    const ratio = normalizeVideoAspectRatio(value);
    return ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"].includes(ratio) ? ratio : "16:9";
}

function unwrapMiniMaxResponse(payload: MiniMaxVideoResponse | { data?: MiniMaxVideoResponse }) {
    let response = payload as MiniMaxVideoResponse & { data?: unknown; task?: unknown; result?: unknown };
    for (let depth = 0; depth < 5; depth += 1) {
        if (response.status || response.task_id || response.id || response.result_url || response.video_url || response.url) return response;
        let nested = response.data || response.task || response.result;
        if (!nested && typeof response.message === "string") {
            try { nested = JSON.parse(response.message); } catch { return response; }
        }
        if (!nested || typeof nested !== "object") return response;
        response = nested as typeof response;
    }
    return response;
}

function miniMaxTaskId(payload: MiniMaxVideoResponse) {
    const visit = (value: unknown, depth = 0): string => {
        if (!value || typeof value !== "object" || depth > 4) return "";
        const record = value as Record<string, unknown>;
        if (typeof record.task_id === "string" && record.task_id) return record.task_id;
        if (typeof record.id === "string" && record.id) return record.id;
        return visit(record.data, depth + 1) || visit(record.task, depth + 1) || visit(record.result, depth + 1);
    };
    return visit(payload);
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

function normalizeSdVideoRatio(value: string) {
    const ratio = normalizeVideoAspectRatio(value);
    return ["1:1", "16:9", "9:16"].includes(ratio) ? ratio : "16:9";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function sdFailureMessage(status: string | undefined) {
    return status?.replace(/^FAILED\s*:?\s*/i, "").trim() || "SD 视频生成失败";
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

type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };

type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);


type GeminiInlineData = { bytesBase64Encoded: string; mimeType: string };
type GeminiVideoOperation = {
    name?: string;
    done?: boolean;
    error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
};

function geminiVideoBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}


function geminiVideoUrl(config: Pick<AiConfig, "baseUrl">, model: string, action: string) {
    return buildAiProxyUrl(`${geminiVideoBaseUrl(config)}/models/${encodeURIComponent(modelOptionName(model).replace(/^models\//, ""))}:${action}`);
}


function geminiOperationUrl(config: Pick<AiConfig, "baseUrl">, name: string) {
    return buildAiProxyUrl(`${geminiVideoBaseUrl(config)}/${name.replace(/^\//, "")}`);
}


function geminiVideoHeaders(config: Pick<AiConfig, "apiKey">) {
    return { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };
}


function videoAspectRatio(size: string) {
    const ratio = inferVideoRatio(size);
    return ratio === "auto" ? "16:9" : ratio;
}


function parseDataUrlInline(dataUrl: string, fallbackType = "image/png"): GeminiInlineData {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    return { bytesBase64Encoded: match?.[2] || "", mimeType: match?.[1] || fallbackType };
}


async function fileToGeminiInline(file: File): Promise<GeminiInlineData> {
    return parseDataUrlInline(await readFileAsDataUrl(file), file.type || "application/octet-stream");
}


async function referenceMediaToFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText(errorKey));
        try {
            blob = await (await fetch(url, { signal: options?.signal })).blob();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            throw new Error(apiText(errorKey));
        }
    }
    if (!blob.size) throw new Error(apiText(errorKey));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}


function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}


function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}


async function createGeminiVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions, captureRequestParams?: CaptureRequestParams): Promise<VideoGenerationTaskHandle> {
    const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const mode = resolveVideoMode(config.videoMode, images.length);
    const instance: Record<string, unknown> = { prompt };
    if (mode === "frames") {
        if (images[0]) instance.image = parseDataUrlInline(images[0]);
        if (images[1]) instance.lastFrame = parseDataUrlInline(images[1]);
    } else instance.referenceImages = images.map((image) => ({ image: parseDataUrlInline(image), referenceType: "asset" }));
    if (videoReferences[0]) instance.video = await fileToGeminiInline(await referenceMediaToFile(videoReferences[0], "ref.mp4", "invalidReferenceVideo", options));
    if (audioReferences[0]) instance.audio = await fileToGeminiInline(await referenceMediaToFile(audioReferences[0], "ref.mp3", "invalidReferenceAudio", options));
    const body = { instances: [instance], parameters: { aspectRatio: videoAspectRatio(config.size), durationSeconds: Number(normalizeVideoSeconds(config.videoSeconds)), resolution: normalizeVideoResolution(config.vquality), generateAudio: boolConfig(config.videoGenerateAudio, true), addWatermark: boolConfig(config.videoWatermark, false) } };
    captureRequestParams?.(body);
    try {
        const created = unwrapEnvelope((await axios.post<ApiEnvelope<GeminiVideoOperation>>(geminiVideoUrl(config, model, "predictLongRunning"), body, { headers: geminiVideoHeaders(config), signal: options?.signal })).data, apiText("noVideoTask"));
        if (!created.name) throw new Error(apiText("noVideoTaskId"));
        return { id: created.name, provider: "gemini", model };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, apiText("videoTaskCreateFailed")), buildAiErrorResponseResult(error));
    }
}

async function pollGeminiVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapEnvelope((await axios.get<ApiEnvelope<GeminiVideoOperation>>(geminiOperationUrl(config, task.id), { headers: geminiVideoHeaders(config), signal: options?.signal })).data, apiText("videoTaskQueryFailed"));
        if (state.error) return { status: "failed", error: readApiErrorMessage(state.error) || apiText("videoGenerationFailed"), responseResult: state };
        if (!state.done) return { status: "pending" };
        const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!uri) return { status: "failed", error: apiText("noPlayableVideo"), responseResult: state };
        const url = new URL(uri);
        if (!url.searchParams.has("key")) url.searchParams.set("key", config.apiKey);
        return { status: "completed", result: { url: url.toString(), mimeType: "video/mp4", responseResult: state } };
    } catch (error) {
        throw videoResponseError(readAxiosError(error, apiText("videoTaskQueryFailed")), buildAiErrorResponseResult(error));
    }
}
