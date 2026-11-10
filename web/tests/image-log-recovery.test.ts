import { expect, test } from "bun:test";
import { compactImageLogTraces, canPollImageItem, normalizeImageLogItem, restoreImageLogResources, type ImageLogResource } from "../src/lib/image-generation-log";
import type { GeneratedImage, GenerationLog, ImageGenerationLogItem } from "../src/types/image-generation";
const image: GeneratedImage = { id: "image", dataUrl: "", storageKey: "image:result", width: 1, height: 1, bytes: 68, durationMs: 0 };
const waiting = (): ImageGenerationLogItem => ({ id: "slot", status: "waiting", taskCreatedAt: 123, task: { id: "task", model: "test", provider: "openai" } as ImageGenerationLogItem["task"] });
const log = (item: ImageGenerationLogItem): GenerationLog => ({ id: "log", items: [item], images: [], createdAt: 100 } as unknown as GenerationLog);
const resource = (patch: Partial<ImageLogResource> = {}): ImageLogResource => ({ storageKey: image.storageKey!, hasFile: true, deleted: false, bytes: 68, mimeType: "image/png", metadata: { logId: "log", itemId: "slot", taskCreatedAt: 123, imageId: "image", width: 1, height: 1 }, ...patch });

test("saved images and explicit failures take precedence over stale waiting tasks", () => {
    const success = normalizeImageLogItem({ ...waiting(), image });
    const failed = normalizeImageLogItem({ ...waiting(), error: "内容被拒绝" });
    expect(success.status).toBe("success");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("内容被拒绝");
    for (const item of [success, failed]) { expect(item.task).toBeUndefined(); expect(canPollImageItem(item)).toBe(false); }
    expect(canPollImageItem(normalizeImageLogItem(waiting()))).toBe(true);
});
test("server resource restores success when terminal log save was lost", () => {
    const [restored] = restoreImageLogResources([log(waiting())], [resource()]);
    expect(restored.status).toBe("成功");
    expect(restored.items[0].image?.storageKey).toBe(image.storageKey);
    expect(restored.items[0].image?.resourceDeleted).toBe(false);
    expect(canPollImageItem(restored.items[0])).toBe(false);
});
test("deleted, missing-file and absent resources display cleared without polling", () => {
    for (const resources of [[resource({ deleted: true, hasFile: false })], [resource({ hasFile: false })], []]) {
        const [restored] = restoreImageLogResources([log({ ...waiting(), image })], resources);
        expect(restored.items[0].image?.resourceDeleted).toBe(true);
        expect(restored.items[0].status).toBe("success");
        expect(canPollImageItem(restored.items[0])).toBe(false);
    }
});
test("a deleted resource also recovers a lost terminal update, while a retry does not inherit old success", () => {
    const [cleared] = restoreImageLogResources([log(waiting())], [resource({ deleted: true, hasFile: false })]);
    expect(cleared.items[0].image?.resourceDeleted).toBe(true);
    expect(canPollImageItem(cleared.items[0])).toBe(false);
    const [retry] = restoreImageLogResources([log({ ...waiting(), taskCreatedAt: 456 })], [resource()]);
    expect(canPollImageItem(retry.items[0])).toBe(true);
});
test("interrupted local processing and success without result cannot become an endless pending card", () => {
    for (const status of ["creating", "rendering", "success"] as const) {
        const item = normalizeImageLogItem({ id: "slot", status });
        expect(item.status).toBe("failed");
        expect(item.error).toBeTruthy();
        expect(canPollImageItem(item)).toBe(false);
    }
});

test("history compacts binary traces without losing images, task identity or error details", () => {
    const binary = "A".repeat(8192);
    const error = "内容被拒绝：请修改提示词";
    const original = log({ ...waiting(), image: { ...image, dataUrl: `data:image/png;base64,${binary}` },
        requestParams: { prompt: "参考图", image: `data:image/png;base64,${binary}` },
        responseResult: { data: [{ b64_json: binary }], error: { message: error } },
        task: { ...waiting().task!, createResponse: { data: binary } },
    });
    const compact = compactImageLogTraces(original);
    expect(compact.items[0].image).toEqual(original.items[0].image);
    expect(compact.items[0].task?.id).toBe("task");
    expect((compact.items[0].responseResult as any).error.message).toBe(error);
    expect((compact.items[0].responseResult as any).data[0].b64_json).toContain("base64 内容已省略");
    expect((compact.items[0].requestParams as any).prompt).toBe("参考图");
    expect(JSON.stringify(compact.items[0].task)).not.toContain(binary);
    expect((original.items[0].responseResult as any).data[0].b64_json).toBe(binary);
    expect(compactImageLogTraces(compact)).toEqual(compact);
});
