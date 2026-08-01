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
    requestParams?: unknown;
    responseResult?: unknown;
    errorMessage?: string;
};

type ErrorRecord = Record<string, unknown>;

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

// 生成结束后上报一条 AI 调用日志。无论收费与否都调用；失败静默，绝不影响生成主流程。
export async function reportAiCall(input: ReportAiCallInput) {
    try {
        await fetch("/api/user/ai-logs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        });
    } catch {
        // 日志上报失败不影响用户，静默吞掉。
    }
}
