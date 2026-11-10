import type { AiConfig } from "@/stores/use-config-store";
import type { ImageGenerationTask } from "@/services/api/image";
import type { ReferenceImage } from "@/types/image";

export type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
    resourceDeleted?: boolean;
};

export type GenerationResult = {
    id: string;
    logId?: string;
    itemId?: string;
    status: "pending" | "success" | "failed";
    phase?: "creating" | "waiting" | "rendering";
    progress?: number;
    taskCreatedAt?: number;
    resultReceivedAt?: number;
    waitingDurationMs?: number;
    renderDurationMs?: number;
    image?: GeneratedImage;
    error?: string;
};

export type ImageGenerationLogItem = {
    id: string;
    status: "creating" | "waiting" | "rendering" | "success" | "failed";
    task?: ImageGenerationTask;
    progress?: number;
    taskCreatedAt?: number;
    resultReceivedAt?: number;
    waitingDurationMs?: number;
    renderDurationMs?: number;
    image?: GeneratedImage;
    error?: string;
    requestParams?: unknown;
    responseResult?: unknown;
};

export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    resolution: string;
    status: "生成中" | "成功" | "失败";
    items: ImageGenerationLogItem[];
    images: GeneratedImage[];
    thumbnails: string[];
    agentTaskId?: string;
};

export type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "resolution" | "size" | "count">;

