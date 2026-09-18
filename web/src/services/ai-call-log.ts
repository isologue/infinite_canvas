"use client";

export type AiCallLogKind = "image" | "video" | "audio" | "text" | "other";
export type AiCallLogStatus = "success" | "failed";

export type ReferenceAssetLogCounts = {
    images?: number;
    videos?: number;
    audios?: number;
    hasMask?: boolean;
};

export function buildReferenceAssetLogParams({ images, videos, audios, hasMask }: ReferenceAssetLogCounts) {
    return {
        ...(images === undefined ? {} : { hasReferenceImages: images > 0, referenceImageCount: images }),
        ...(videos === undefined ? {} : { hasReferenceVideos: videos > 0, referenceVideoCount: videos }),
        ...(audios === undefined ? {} : { hasReferenceAudios: audios > 0, referenceAudioCount: audios }),
        ...(hasMask === undefined ? {} : { hasMask }),
    };
}

export type ReportAiCallInput = {
    kind: AiCallLogKind;
    model: string;
    status: AiCallLogStatus;
    reason?: string;
    durationSeconds?: number;
    requestParams?: unknown;
    responseResult?: unknown;
    errorMessage?: string;
};

type ErrorRecord = Record<string, unknown>;

const BASE64_VALUE_PATTERN = /^(?:data:[^;,]+;base64,)?[A-Za-z0-9+/\r\n]+={0,2}$/;
const BASE64_VALUE_MIN_LENGTH = 4096;

function compactBinaryValue(value: string) {
    if (value.length < BASE64_VALUE_MIN_LENGTH || !BASE64_VALUE_PATTERN.test(value)) return value;
    const comma = value.indexOf(",");
    const prefix = comma >= 0 ? value.slice(0, comma + 1) : "";
    return `${prefix}[base64 内容已省略，共 ${value.length - prefix.length} 个字符]`;
}

// 日志保留真实请求/响应结构与普通文本；仅省略无法直接排障且会显著撑大数据库的二进制 base64 内容。
export function prepareAiLogValue(value: unknown): unknown {
    const visited = new WeakSet<object>();
    const walk = (current: unknown): unknown => {
        if (typeof current === "string") return compactBinaryValue(current);
        if (current === null || current === undefined || typeof current !== "object") return current;
        if (typeof Blob !== "undefined" && current instanceof Blob) {
            return {
                ...(typeof File !== "undefined" && current instanceof File ? { name: current.name } : {}),
                type: current.type,
                bytes: current.size,
            };
        }
        if (visited.has(current)) return "[循环引用]";
        visited.add(current);
        if (Array.isArray(current)) return current.map(walk);
        return Object.fromEntries(Object.entries(current as ErrorRecord).map(([key, item]) => [key, walk(item)]));
    };
    return walk(value);
}

export function buildAiErrorResponseResult(error: unknown): unknown {
    const visited = new Set<unknown>();
    let current = error;
    while (current && typeof current === "object" && !visited.has(current)) {
        visited.add(current);
        const record = current as ErrorRecord;
        if (record.responseResult !== undefined) return record.responseResult;
        const response = record.response;
        if (response && typeof response === "object") {
            const responseRecord = response as ErrorRecord;
            return {
                ...(typeof responseRecord.status === "number" ? { status: responseRecord.status } : {}),
                ...(typeof responseRecord.statusText === "string" && responseRecord.statusText ? { statusText: responseRecord.statusText } : {}),
                ...(responseRecord.data === undefined ? {} : { data: responseRecord.data }),
            };
        }
        current = record.cause;
    }
    return undefined;
}

export function buildAiErrorRequestParams(error: unknown): unknown {
    const visited = new Set<unknown>();
    let current = error;
    while (current && typeof current === "object" && !visited.has(current)) {
        visited.add(current);
        const record = current as ErrorRecord;
        if (record.requestParams !== undefined) return record.requestParams;
        current = record.cause;
    }
    return undefined;
}

export function generationDurationSeconds(startedAt: number, endedAt = Date.now()) {
    return Math.round((Math.max(0, endedAt - startedAt) / 1000) * 1000) / 1000;
}

// 生成结束后上报一条 AI 调用日志。无论收费与否都调用；失败静默，绝不影响生成主流程。
export async function reportAiCall(input: ReportAiCallInput) {
    try {
        await fetch("/api/user/ai-logs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...input, requestParams: prepareAiLogValue(input.requestParams), responseResult: prepareAiLogValue(input.responseResult) }),
        });
    } catch {
        // 日志上报失败不影响用户，静默吞掉。
    }
}
