import axios from "axios";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";

const storage = new Map<string, string>();
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
});

const { defaultConfig } = await import("../src/stores/use-config-store");
const { createEditableFileTask, downloadEditableFile, FILE_TASK_POLL_INTERVAL_MS, normalizeEditableFileTask, pollEditableFileTask } = await import("../src/services/api/editable-files");
const config: AiConfig = {
    ...defaultConfig,
    channels: [{
        id: "files", name: "Files", baseUrl: "https://api.example.test/v1", apiKey: "secret", apiFormat: "openai", apiFormatMode: "manual",
        imageResponseFormat: "url", referenceImageRequestFormat: "json", models: [{ name: "designer-v1", capability: "file" }],
    }],
};
const task = (kind: "ppt" | "psd" | "svg", status: "queued" | "running" | "success" | "error" = "queued") => ({
    id: "task / 1", taskId: "task / 1", kind, status, created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", elapsed_seconds: 1,
    ...(status === "success" ? { result: { primary_url: "https://api.example.test/files/output.pptx" } } : {}),
    ...(status === "error" ? { error: { code: "failed", message: "generation failed" } } : {}),
});
const { useUploadStore } = await import("../src/stores/use-upload-store");
const savedFiles: string[] = [];
mock.module("file-saver", () => ({ saveAs: (_blob: Blob, filename: string) => savedFiles.push(filename) }));
const originalRequest = axios.request;
const originalGet = axios.get;
afterEach(() => { axios.request = originalRequest; axios.get = originalGet; useUploadStore.getState().reset(); savedFiles.length = 0; });
afterAll(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("creates PPTX, PSD, and SVG tasks with the documented JSON payload", async () => {
    const calls: Array<{ url?: string; data?: unknown }> = [];
    axios.request = (async (options: { url?: string; data?: unknown }) => {
        calls.push(options);
        const kind = options.url?.includes("/ppt/") ? "ppt" : options.url?.includes("/psd/") ? "psd" : "svg";
        return { data: task(kind), status: 200 };
    }) as typeof axios.request;

    for (const kind of ["ppt", "psd", "svg"] as const) {
        const images = kind === "psd" ? ["data:image/png;base64,AA=="] : [];
        await createEditableFileTask(config, "files::designer-v1", { kind, prompt: "design", clientTaskId: `${kind}-1`, images });
    }

    expect(calls.map((call) => call.url)).toEqual([
        "/api/ai-proxy?url=https%3A%2F%2Fapi.example.test%2Fv1%2Fppt%2Fgenerations",
        "/api/ai-proxy?url=https%3A%2F%2Fapi.example.test%2Fv1%2Fpsd%2Fgenerations",
        "/api/ai-proxy?url=https%3A%2F%2Fapi.example.test%2Fv1%2Fsvg%2Fgenerations",
    ]);
    expect(calls.map((call) => call.data)).toEqual([
        { model: "designer-v1", prompt: "design", client_task_id: "ppt-1", base64_images: [] },
        { model: "designer-v1", prompt: "design", client_task_id: "psd-1", base64_images: ["data:image/png;base64,AA=="] },
        { model: "designer-v1", prompt: "design", client_task_id: "svg-1", base64_images: [] },
    ]);
});

test("rejects PSD creation without a reference image before making a request", async () => {
    let called = false;
    axios.request = (async () => { called = true; return { data: task("psd"), status: 200 }; }) as typeof axios.request;
    await expect(createEditableFileTask(config, "files::designer-v1", { kind: "psd", prompt: "design", clientTaskId: "psd-1", images: [] })).rejects.toThrow("PSD 生成至少需要一张参考图");
    expect(called).toBe(false);
});

test("normalizes terminal states and rejects malformed terminal payloads", () => {
    expect(normalizeEditableFileTask(task("ppt", "success"), "ppt").status).toBe("success");
    expect(normalizeEditableFileTask(task("ppt", "error"), "ppt").error?.message).toBe("generation failed");
    expect(() => normalizeEditableFileTask({ ...task("ppt", "success"), result: undefined }, "ppt")).toThrow("没有返回主文件链接");
    expect(() => normalizeEditableFileTask({ ...task("ppt", "error"), error: undefined }, "ppt")).toThrow("文件生成失败");
});

test("polls the escaped task id and enforces the five-second interval", async () => {
    let calledUrl = "";
    axios.request = (async (options: { url?: string }) => { calledUrl = options.url || ""; return { data: task("svg", "running"), status: 200 }; }) as typeof axios.request;
    await pollEditableFileTask(config, "files::designer-v1", task("svg"));
    expect(calledUrl).toBe("/api/ai-proxy?url=https%3A%2F%2Fapi.example.test%2Fv1%2Feditable-file-tasks%2Ftask%2520%252F%25201");
    expect(FILE_TASK_POLL_INTERVAL_MS).toBe(5_000);
});

test("rejects file download URLs outside the selected channel origin", async () => {
    await expect(downloadEditableFile(config, "files::designer-v1", "https://other.example.test/files/a.svg", "a.svg")).rejects.toThrow("域名不一致");
});

test("download opens the shared panel and tracks known and unknown total bytes", async () => {
    useUploadStore.getState().setHidden(true);
    useUploadStore.getState().setCollapsed(true);
    axios.get = (async (_url: string, options: { onDownloadProgress: (event: { loaded: number; total?: number }) => void }) => {
        expect(useUploadStore.getState().hidden).toBe(false);
        expect(useUploadStore.getState().collapsed).toBe(false);
        expect(useUploadStore.getState().records[0].direction).toBe("download");
        options.onDownloadProgress({ loaded: 10 });
        expect(useUploadStore.getState().records[0]).toMatchObject({ status: "downloading", progress: 0, receivedBytes: 10, totalKnown: false });
        options.onDownloadProgress({ loaded: 15, total: 30 });
        expect(useUploadStore.getState().records[0]).toMatchObject({ progress: 50, receivedBytes: 15, bytes: 30, totalKnown: true });
        expect(options).not.toHaveProperty("headers");
        return { data: new Blob(["file content"], { type: "application/octet-stream" }) };
    }) as typeof axios.get;
    await downloadEditableFile(config, "files::designer-v1", "/files/output.pptx", "演示文稿.pptx");
    expect(useUploadStore.getState().records[0]).toMatchObject({ status: "success", progress: 100 });
    expect(savedFiles).toEqual(["演示文稿.pptx"]);
});

test("empty files and error pages fail visibly instead of saving invalid downloads", async () => {
    for (const blob of [new Blob([]), new Blob(['{"error":"not found"}'], { type: "application/json" }), new Blob(["<html>error</html>"], { type: "text/html" })]) {
        axios.get = (async () => ({ data: blob })) as typeof axios.get;
        await expect(downloadEditableFile(config, "files::designer-v1", "/files/out.zip", "out.zip")).rejects.toThrow();
        expect(useUploadStore.getState().records[0].status).toBe("error");
    }
    expect(savedFiles).toEqual([]);
});

test("expired links show the cleanup reason in the progress panel", async () => {
    axios.get = (async () => { throw new axios.AxiosError("HTTP 404", "ERR_BAD_REQUEST", undefined, undefined, { status: 404 } as never); }) as typeof axios.get;
    await expect(downloadEditableFile(config, "files::designer-v1", "/files/gone.pptx", "gone.pptx")).rejects.toThrow("文件已被清理或下载链接已失效");
    expect(useUploadStore.getState().records[0]).toMatchObject({ status: "error", error: "文件已被清理或下载链接已失效" });
    expect(savedFiles).toEqual([]);
});

test("upload and download records coexist and clearing finished keeps active transfers", () => {
    const store = useUploadStore.getState();
    const upload = store.start("image.png", "image", 1024);
    const download = store.start("deck.pptx", "file", 0, "download");
    expect(useUploadStore.getState().records.find((record) => record.id === upload)?.direction).toBe("upload");
    store.update(download, { status: "success", progress: 100 });
    store.clearFinished();
    expect(useUploadStore.getState().records.map((record) => record.id)).toEqual([upload]);
});


test("stored files download through user-scoped storage without a channel key or channel configuration", async () => {
    let calledUrl = "";
    axios.get = (async (url: string, options: object) => {
        calledUrl = url;
        expect(options).not.toHaveProperty("headers");
        return { data: new Blob(["stored file"], { type: "application/octet-stream" }) };
    }) as typeof axios.get;
    await downloadEditableFile({ ...config, channels: [] }, "removed-channel", "https://dav.example.test/deck.pptx", "stored.pptx", { storageKey: "file:task:primary", bytes: 11, mimeType: "application/octet-stream", url: "https://dav.example.test/deck.pptx" });
    expect(calledUrl).toBe("/api/storage/files/file%3Atask%3Aprimary");
    expect(savedFiles).toEqual(["stored.pptx"]);
    expect(useUploadStore.getState().records[0].status).toBe("success");
});
