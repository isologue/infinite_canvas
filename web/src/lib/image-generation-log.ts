import type { GeneratedImage, GenerationLog, ImageGenerationLogItem } from "@/types/image-generation";

export function canPollImageItem(item: ImageGenerationLogItem) {
    return Boolean(item.task && ["waiting", "creating"].includes(item.status) && !item.image && !item.error);
}

export function normalizeImageLogItem(item: ImageGenerationLogItem): ImageGenerationLogItem {
    if (item.image) return { ...item, status: "success", task: undefined, progress: 100, error: undefined };
    if (item.status === "failed") return { ...item, task: undefined };
    if (item.status === "success") return { ...item, status: "failed", task: undefined, error: "图片任务已完成，但图片结果未保存，请重新生成" };
    if (item.error) return { ...item, status: "failed", task: undefined };
    if (!canPollImageItem(item)) return { ...item, status: "failed", task: undefined, error: "生成已中断，未保存可恢复的任务或图片，请重新生成" };
    return item;
}

export function finalizeImageLog(log: GenerationLog): GenerationLog {
    const items = log.items || [];
    const images = items.map((item) => item.image).filter((image): image is GeneratedImage => Boolean(image));
    const successCount = items.filter((item) => item.status === "success").length;
    const failCount = items.filter((item) => item.status === "failed").length;
    const pending = items.some((item) => !["success", "failed"].includes(item.status));
    return {
        ...log,
        items,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
        successCount,
        failCount,
        imageCount: items.length || log.imageCount,
        status: pending ? "生成中" : successCount ? "成功" : "失败",
        durationMs: Math.max(log.durationMs || 0, ...items.map((item) => (item.waitingDurationMs || 0) + (item.renderDurationMs || 0)), 0),
    };
}

export type ImageLogResource = {
    storageKey: string;
    deleted: boolean;
    hasFile: boolean;
    bytes: number;
    mimeType: string;
    metadata: { logId?: string; itemId?: string; imageId?: string; taskCreatedAt?: number; width?: number; height?: number };
};

export function restoreImageLogResources(logs: GenerationLog[], resources: ImageLogResource[]) {
    const byKey = new Map(resources.map((resource) => [resource.storageKey, resource]));
    const byItem = new Map<string, ImageLogResource>();
    // 资源按新到旧排列，关联时包含本次任务起始时间，避免重试误用上次结果。
    for (const resource of resources) {
        const { logId, itemId, taskCreatedAt } = resource.metadata;
        const key = JSON.stringify([logId, itemId, taskCreatedAt]);
        if (logId && itemId && !byItem.has(key)) byItem.set(key, resource);
    }
    return logs.map((log) => {
        const items: ImageGenerationLogItem[] = log.items?.length ? log.items : (log.images || []).map((image) => ({ id: image.id, status: "success" as const, image }));
        return finalizeImageLog({ ...log, items: items.map((item) => {
            let image = item.image;
            const resource = image?.storageKey ? byKey.get(image.storageKey) : byItem.get(JSON.stringify([log.id, item.id, item.taskCreatedAt]));
            if (!image && resource && item.status !== "failed") image = {
                id: resource.metadata.imageId || item.id, dataUrl: "", storageKey: resource.storageKey,
                width: Number(resource.metadata.width || 0), height: Number(resource.metadata.height || 0),
                bytes: resource.bytes, mimeType: resource.mimeType, durationMs: 0,
            };
            if (image?.storageKey) image = { ...image, resourceDeleted: !resource || resource.deleted || !resource.hasFile, dataUrl: "" };
            return normalizeImageLogItem({ ...item, image });
        }) });
    });
}
