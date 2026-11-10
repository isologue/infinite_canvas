import { afterEach, expect, mock, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { hydrateCanvasImages } from "../src/lib/canvas/canvas-generation-helpers";
import { sanitizeCanvasProject, type CanvasProject } from "../src/services/api/canvas-projects";
import { readZip } from "../src/lib/zip";
const downloads: Blob[] = [];
mock.module("file-saver", () => ({ saveAs: (blob: Blob) => downloads.push(blob) }));
const { exportCanvasNodes } = await import("../src/lib/canvas/canvas-export");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; downloads.length = 0; });
const node = (metadata: Record<string, unknown>): CanvasNodeData => ({ id: "img", type: CanvasNodeType.Image, title: "生成图片", position: { x: 0, y: 0 }, width: 200, height: 200, metadata } as CanvasNodeData);
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSk0AAAAASUVORK5CYII="), c => c.charCodeAt(0));
test("primary and batch images restore from keys after save strips URLs", async () => {
    const p = sanitizeCanvasProject({ id: "test", nodes: [node({ content: "blob:old", storageKey: "image:main", images: [{ id: "b", content: "blob:old", storageKey: "image:batch" }] })] } as CanvasProject);
    expect(p.nodes[0].metadata?.content).toBe("");
    const [restored] = await hydrateCanvasImages(p.nodes);
    expect(restored.metadata?.content).toBe("/api/storage/files/image%3Amain");
    expect(restored.metadata?.images?.[0].content).toBe("/api/storage/files/image%3Abatch");
});
test("batch-only node restores without a primary image", async () => {
    const [restored] = await hydrateCanvasImages([node({ images: [{ id: "b", content: "", storageKey: "image:batch" }] })]);
    expect(restored.metadata?.images?.[0].content).toBe("/api/storage/files/image%3Abatch");
});
test("ZIP preserves original bytes and unique Chinese file names", async () => {
    globalThis.fetch = (async () => new Response(png, { headers: { "content-type": "image/png" } })) as typeof fetch;
    await exportCanvasNodes([node({ storageKey: "image:a" }), node({ storageKey: "image:b" })]);
    const files = await readZip(downloads[0]);
    expect([...files.keys()]).toEqual(["生成图片.png", "生成图片-1.png"]);
    for (const file of files.values()) expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
});
test("ZIP sanitizes Windows-invalid control characters and keeps cleaned names unique", async () => {
    const title = "【文本1】\n画一张 X 的内容截图，深色模式，@OpenAI 蓝";
    globalThis.fetch = (async () => new Response(png, { headers: { "content-type": "image/png" } })) as typeof fetch;
    await exportCanvasNodes([{ ...node({ storageKey: "image:a" }), title }, { ...node({ storageKey: "image:b" }), title: title.replace("\n", "\r") }]);
    const files = await readZip(downloads[0]);
    expect([...files.keys()]).toEqual([
        "【文本1】_画一张 X 的内容截图，深色模式，@OpenAI 蓝.png",
        "【文本1】_画一张 X 的内容截图，深色模式，@OpenAI 蓝-1.png",
    ]);
});
test("missing originals stop export instead of downloading empty or incomplete ZIP", async () => {
    globalThis.fetch = (async (url: string) => url.includes("good") ? new Response(png, { headers: { "content-type": "image/png" } }) : new Response("missing", { status: 404 })) as typeof fetch;
    await expect(exportCanvasNodes([node({ storageKey: "image:missing" })])).rejects.toThrow("资源");
    await expect(exportCanvasNodes([node({ storageKey: "image:good" }), node({ storageKey: "image:missing" })])).rejects.toThrow("资源");
    expect(downloads).toHaveLength(0);
});
test("empty selection and zero-byte originals cannot produce a successful download", async () => {
    await expect(exportCanvasNodes([])).rejects.toThrow();
    globalThis.fetch = (async () => new Response(new Blob([], { type: "image/png" }))) as typeof fetch;
    await expect(exportCanvasNodes([node({ storageKey: "image:empty" })])).rejects.toThrow();
    expect(downloads).toHaveLength(0);
});
