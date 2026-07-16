import axios from "axios";

import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import { reportAiCall, type AiCallLogKind } from "@/services/ai-call-log";
import type { ReferenceImage } from "@/types/image";

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

export type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type GeneratedImage = { id: string; dataUrl: string };
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";
const IMAGE_TASK_POLL_INTERVAL_MS = 2500;
const IMAGE_TASK_MAX_ATTEMPTS = 240;
const IMAGE_TASK_MAX_CONSECUTIVE_ERRORS = 5;
const IMAGE_TASK_MAX_INITIAL_NOT_FOUND = 3;
const asyncUnsupported = new Set<string>();

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    if (Math.max(w, h) / Math.min(w, h) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return { width: w, height: h };
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function imageTaskKey(config: AiConfig, endpoint: string) {
    return `${config.apiFormat}:${config.baseUrl.trim().replace(/\/+$/, "")}:${endpoint}:${config.model}`;
}

async function requestImagesWithAsyncFallback(input: {
    key: string;
    config: AiConfig;
    create: (asyncMode: boolean) => Promise<unknown>;
    parseImmediate: (payload: unknown) => GeneratedImage[] | null;
    options?: RequestOptions;
}) {
    if (asyncUnsupported.has(input.key)) return parseRequiredImages(await input.create(false), input.parseImmediate);
    let payload: unknown;
    try {
        payload = await input.create(true);
    } catch (error) {
        if (!shouldFallbackWithoutAsync(error)) throw error;
        const fallback = parseRequiredImages(await input.create(false), input.parseImmediate);
        asyncUnsupported.add(input.key);
        return fallback;
    }
    try {
        const images = input.parseImmediate(payload);
        if (images?.length) return images;
    } catch (error) {
        if (!shouldFallbackWithoutAsync(error)) throw error;
        const fallback = parseRequiredImages(await input.create(false), input.parseImmediate);
        asyncUnsupported.add(input.key);
        return fallback;
    }
    const taskId = imageTaskId(payload);
    if (taskId) return pollImageTask(input.config, taskId, input.parseImmediate, input.options);
    const fallback = parseRequiredImages(await input.create(false), input.parseImmediate);
    asyncUnsupported.add(input.key);
    return fallback;
}

function parseRequiredImages(payload: unknown, preferred: (payload: unknown) => GeneratedImage[] | null) {
    const images = preferred(payload) || findTaskImages(payload);
    if (!images?.length) throw new Error("接口没有返回图片");
    return images;
}

function tryParseOpenAiImages(payload: unknown) {
    if (!isRecord(payload)) return null;
    const message = readPayloadError(payload);
    if (message) {
        const error = new Error(message) as Error & { status?: number };
        if (typeof payload.code === "number") error.status = payload.code;
        throw error;
    }
    if (!Array.isArray(payload.data)) return null;
    const images = payload.data.map((item) => isRecord(item) ? resolveImageDataUrl(item) : null).filter((value): value is string => Boolean(value)).map((dataUrl) => ({ id: nanoid(), dataUrl }));
    return images.length ? images : null;
}

function tryParseGeminiImages(payload: unknown) {
    if (!isRecord(payload)) return null;
    validateGeminiPayload(payload as GeminiPayload);
    if (!Array.isArray(payload.candidates)) return null;
    const images = (payload as GeminiPayload).candidates
        ?.flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => {
            const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
            if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
            return part.fileData?.fileUri || null;
        })
        .filter((value): value is string => Boolean(value))
        .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    return images.length ? images : null;
}

function findTaskImages(payload: unknown, depth = 0): GeneratedImage[] | null {
    if (depth > 4) return null;
    const direct = tryParseOpenAiImages(payload) || tryParseGeminiImages(payload);
    if (direct?.length) return direct;
    if (Array.isArray(payload)) {
        const images = payload.map((item) => isRecord(item) ? resolveImageDataUrl(item) : null).filter((value): value is string => Boolean(value)).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        return images.length ? images : null;
    }
    if (!isRecord(payload)) return null;
    for (const key of ["images", "data", "result", "output", "response"]) {
        const images = findTaskImages(payload[key], depth + 1);
        if (images?.length) return images;
    }
    return null;
}

function imageTaskId(payload: unknown) {
    if (!isRecord(payload)) return "";
    if (typeof payload.task === "string" || typeof payload.task === "number") return String(payload.task).trim();
    for (const key of ["task_id", "taskId"]) {
        if (typeof payload[key] === "string" || typeof payload[key] === "number") return String(payload[key]).trim();
    }
    for (const key of ["task", "data", "result", "response"]) {
        const id = imageTaskId(payload[key]);
        if (id) return id;
    }
    return typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id).trim() : "";
}

function imageTaskStatus(payload: unknown): string {
    if (!isRecord(payload)) return "";
    for (const key of ["status", "state"]) {
        if (typeof payload[key] === "string") return payload[key].trim().toLowerCase();
    }
    for (const key of ["task", "data", "result", "response"]) {
        const status = imageTaskStatus(payload[key]);
        if (status) return status;
    }
    return "";
}

async function pollImageTask(config: AiConfig, taskId: string, preferred: (payload: unknown) => GeneratedImage[] | null, options?: RequestOptions) {
    let consecutiveErrors = 0;
    let initialNotFound = 0;
    for (let attempt = 0; attempt < IMAGE_TASK_MAX_ATTEMPTS; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const response = await axios.get<unknown>(imageTaskApiUrl(config, taskId), {
                headers: config.apiFormat === "gemini" ? geminiHeaders(config) : aiHeaders(config),
                signal: options?.signal,
            });
            consecutiveErrors = 0;
            const payload = response.data;
            const errorMessage = readPayloadError(payload);
            if (errorMessage) throw new Error(errorMessage);
            const images = preferred(payload) || findTaskImages(payload);
            const status = imageTaskStatus(payload);
            if (images?.length && (!status || IMAGE_TASK_SUCCESS.has(status))) return images;
            if (IMAGE_TASK_FAILED.has(status)) throw new Error(readTaskFailure(payload) || `图片任务${status === "expired" ? "已过期" : "失败"}`);
            if (IMAGE_TASK_SUCCESS.has(status)) throw new Error("图片任务已完成，但没有返回图片");
        } catch (error) {
            if (isRequestCancelled(error)) throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (status === 404 && initialNotFound < IMAGE_TASK_MAX_INITIAL_NOT_FOUND) {
                initialNotFound += 1;
            } else if (isTransientTaskError(error) && consecutiveErrors < IMAGE_TASK_MAX_CONSECUTIVE_ERRORS) {
                consecutiveErrors += 1;
            } else {
                throw error;
            }
        }
        await waitForImageTask(IMAGE_TASK_POLL_INTERVAL_MS, options?.signal);
    }
    throw new Error("图片生成任务超时，请稍后重试");
}

const IMAGE_TASK_SUCCESS = new Set(["success", "successful", "succeeded", "completed", "done", "finished"]);
const IMAGE_TASK_FAILED = new Set(["failed", "failure", "error", "cancelled", "canceled", "expired"]);

function readPayloadError(payload: unknown) {
    if (!isRecord(payload)) return "";
    if (typeof payload.code === "number" && payload.code !== 0) return typeof payload.msg === "string" ? payload.msg : isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : "请求失败";
    if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
    return "";
}

function readTaskFailure(payload: unknown): string {
    if (!isRecord(payload)) return "";
    const error = readPayloadError(payload);
    if (error) return error;
    if (typeof payload.error === "string" && payload.error) return payload.error;
    if (typeof payload.message === "string" && payload.message) return payload.message;
    if (typeof payload.msg === "string" && payload.msg) return payload.msg;
    for (const key of ["task", "data", "result", "response"]) {
        const message = readTaskFailure(payload[key]);
        if (message) return message;
    }
    return "";
}

function shouldFallbackWithoutAsync(error: unknown) {
    if (isRequestCancelled(error)) return false;
    const status = axios.isAxiosError(error) ? error.response?.status : isRecord(error) && typeof error.status === "number" ? error.status : undefined;
    if (status && [401, 403, 429].includes(status)) return false;
    if (status && [400, 404, 405, 415, 422].includes(status)) return true;
    return /(?:unknown|unsupported|not support|unrecognized|unexpected).{0,40}async|async.{0,40}(?:unknown|unsupported|not support|unrecognized|unexpected)/i.test(readAxiosError(error, ""));
}

function isTransientTaskError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    return !error.response || status === 408 || status === 425 || status === 429 || Boolean(status && status >= 500);
}

function isRequestCancelled(error: unknown) {
    return axios.isCancel(error) || error instanceof DOMException && error.name === "AbortError";
}

function waitForImageTask(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || readStatusError(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}：${status}` : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function imageTaskApiUrl(config: AiConfig, taskId: string) {
    if (config.apiFormat !== "gemini") return aiApiUrl(config, `/images/tasks/${encodeURIComponent(taskId)}`);
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/(?:v1beta|v1)$/i, "");
    return `${baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}`;
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function aiLogKindFromReason(kind: string): AiCallLogKind {
    if (kind.startsWith("image")) return "image";
    if (kind.startsWith("text")) return "text";
    return "other";
}

// 从生成参数里挑出适合入日志的字段（不含 base64 图片，避免日志膨胀）。
function buildImageRequestParams(config: AiConfig) {
    return {
        model: modelOptionName(config.model),
        count: config.count,
        size: (config as { size?: unknown }).size,
        quality: (config as { quality?: unknown }).quality,
        prompt: (config as { prompt?: unknown }).prompt,
    };
}

// 包裹生成调用并上报 AI 调用日志。图片类日志由页面层在拿到 storageKey 后上报（这里只有 base64），此处只报文本等非图片类型。
async function withGenerationLog<T>(config: AiConfig, kind: string, run: () => Promise<T>) {
    const model = modelOptionName(config.model);
    const logKind = aiLogKindFromReason(kind);
    const requestParams = buildImageRequestParams(config);
    try {
        const result = await run();
        if (logKind !== "image") {
            void reportAiCall({ kind: logKind, model, status: "success", reason: kind, requestParams });
        }
        return result;
    } catch (error) {
        if (logKind !== "image") {
            void reportAiCall({ kind: logKind, model, status: "failed", reason: kind, requestParams, errorMessage: error instanceof Error ? error.message : String(error) });
        }
        throw error;
    }
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "Request failed");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini refused this request: ${payload.promptFeedback.blockReason}`);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        consumeResponseStreamBlock(state.buffer.slice(0, match.index ?? 0), state, onDelta);
        state.buffer = state.buffer.slice((match.index ?? 0) + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "Request failed"));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "Request failed"));
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        consumeGeminiStreamBlock(state.buffer.slice(0, match.index ?? 0), state, onDelta);
        state.buffer = state.buffer.slice((match.index ?? 0) + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const body = {
        ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
        contents: [{ role: "user", parts }],
    };
    return requestImagesWithAsyncFallback({
        key: imageTaskKey(config, "gemini:generateContent"),
        config,
        create: async (asyncMode) => (await axios.post<unknown>(
            geminiApiUrl(config, "generateContent"),
            asyncMode ? { ...body, async: true } : body,
            { headers: geminiHeaders(config), signal: options?.signal },
        )).data,
        parseImmediate: (payload) => tryParseGeminiImages(payload) || tryParseOpenAiImages(payload),
        options,
    });
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    const images = tryParseGeminiImages(payload);
    if (!images?.length) throw new Error("Gemini returned no image");
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    return withGenerationLog({ ...config, model: config.model || config.imageModel, count: String(n) }, "image generation", async () => {
        if (requestConfig.apiFormat === "gemini") {
            try {
                return await requestGeminiImages(requestConfig, prompt, [], n, options);
            } catch (error) {
                throw new Error(readAxiosError(error, "request failed"));
            }
        }
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        try {
            const body = {
                model: requestConfig.model,
                prompt: withSystemPrompt(requestConfig, prompt),
                n,
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                response_format: "b64_json",
                output_format: IMAGE_OUTPUT_FORMAT,
            };
            return await requestImagesWithAsyncFallback({
                key: imageTaskKey(requestConfig, "/images/generations"),
                config: requestConfig,
                create: async (asyncMode) => (await axios.post<unknown>(
                    aiApiUrl(requestConfig, "/images/generations"),
                    asyncMode ? { ...body, async: true } : body,
                    {
                        headers: aiHeaders(requestConfig, "application/json"),
                        signal: options?.signal,
                    },
                )).data,
                parseImmediate: (payload) => tryParseOpenAiImages(payload) || tryParseGeminiImages(payload),
                options,
            });
        } catch (error) {
            throw new Error(readAxiosError(error, "request failed"));
        }
    });
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    return withGenerationLog({ ...config, model: config.model || config.imageModel, count: String(n) }, "image edit", async () => {
        if (requestConfig.apiFormat === "gemini") {
            if (mask) throw new Error("Gemini does not support mask editing yet");
            try {
                return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
            } catch (error) {
                throw new Error(readAxiosError(error, "request failed"));
            }
        }
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        const createFormData = (asyncMode: boolean) => {
            const formData = new FormData();
            formData.set("model", requestConfig.model);
            formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
            formData.set("n", String(n));
            formData.set("response_format", "b64_json");
            formData.set("output_format", IMAGE_OUTPUT_FORMAT);
            if (asyncMode) formData.set("async", "true");
            if (quality) formData.set("quality", quality);
            if (requestSize) formData.set("size", requestSize);
            files.forEach((file) => formData.append("image", file));
            if (mask) formData.set("mask", dataUrlToFile(mask));
            return formData;
        };

        try {
            return await requestImagesWithAsyncFallback({
                key: imageTaskKey(requestConfig, "/images/edits"),
                config: requestConfig,
                create: async (asyncMode) => (await axios.post<unknown>(aiApiUrl(requestConfig, "/images/edits"), createFormData(asyncMode), { headers: aiHeaders(requestConfig), signal: options?.signal })).data,
                parseImmediate: (payload) => tryParseOpenAiImages(payload) || tryParseGeminiImages(payload),
                options,
            });
        } catch (error) {
            throw new Error(readAxiosError(error, "request failed"));
        }
    });
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    return withGenerationLog({ ...config, model: config.model || config.textModel, count: "1" }, "text generation", async () => {
        try {
            if (requestConfig.apiFormat === "gemini") {
                const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || "No response";
                if (answer === "No response") onDelta(answer);
                return answer;
            }
            const answer = (await requestStreamingResponse(requestConfig, {
                model: requestConfig.model,
                input: toResponseInput(withSystemMessage(requestConfig, messages)),
            }, onDelta, options)).content || "No response";
            if (answer === "No response") onDelta(answer);
            return answer;
        } catch (error) {
            throw new Error(readAxiosError(error, "request failed"));
        }
    });
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    return withGenerationLog({ ...config, model: config.model || config.textModel, count: "1" }, "text tool call", async () => {
        try {
            if (requestConfig.apiFormat === "gemini") {
                return await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages, toGeminiToolOptions(tools, toolChoice)), onDelta, options);
            }
            return await requestStreamingResponse(requestConfig, {
                model: requestConfig.model,
                input: toResponseInput(withSystemMessage(requestConfig, messages)),
                tools: tools.map(toResponseTool),
                tool_choice: toolChoice,
                parallel_tool_calls: false,
            }, onDelta, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "request failed"));
        }
    });
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export async function fetchChannelModels(channel: ModelChannel) {
    return fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
