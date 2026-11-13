import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const calls: Array<{ method: string; url: string; body?: any }> = [];
let respond: (method: string, url: string, body?: any) => unknown = () => ({});
const axios = {
    post: async (url: string, body: unknown) => { calls.push({ method: "POST", url, body }); return { data: respond("POST", url, body) }; },
    get: async (url: string) => { calls.push({ method: "GET", url }); return { data: respond("GET", url) }; },
    request: async (options: any) => { calls.push({ method: options.method, url: options.url, body: options.data }); return { data: respond(options.method, options.url, options.data) }; },
    isAxiosError: (error: any) => Boolean(error?.isAxiosError),
    isCancel: () => false,
};
mock.module("axios", () => ({ default: axios }));
const { defaultConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { createImageGenerationTask, pollImageGenerationTask } = await import("../src/services/api/image");
const { createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");
const { getPluginTemplates } = await import("../src/services/api/model-plugin");
const { buildNodeGenerationContext } = await import("../src/components/canvas/canvas-node-generation");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSk0AAAAASUVORK5CYII=";
const originalFetch = globalThis.fetch;
let publicUploads = 0;
function config(capability: "image" | "video" = "image", protocol = "openai", name = capability === "image" ? "gpt-image-2" : "video-model") {
    const channel = { ...defaultConfig.channels[0], id: "test", apiFormat: protocol, apiKey: "test-key", baseUrl: "https://example.com", models: [{ name, capability }] };
    return { ...defaultConfig, model: `test::${name}`, [`${capability}Model`]: `test::${name}`, channels: [channel], apiFormat: protocol, apiKey: "test-key", baseUrl: "https://example.com", size: "16:9", resolution: "2K", count: "1", quality: "high" } as typeof defaultConfig;
}
beforeEach(() => {
    calls.length = 0;
    publicUploads = 0;
    useConfigStore.setState({ config: { ...defaultConfig, proxyEnabled: false } });
    globalThis.fetch = mock(async (url: any) => {
        if (String(url).includes("/public-url")) publicUploads++;
        return Response.json({ code: 0, data: { url: `https://media.example.com/ref-${publicUploads}.png` } });
    }) as typeof fetch;
    respond = () => ({ data: [{ url: "https://media.example.com/result.png" }] });
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("OpenAI image keeps async, response format and quality independent of dimensions", async () => {
    for (const quality of ["low", "high", "xhigh", "max"]) {
        const result = await createImageGenerationTask({ ...config(), quality }, "test");
        expect(result.mode).toBe("immediate");
        const body = calls.at(-1)!.body;
        expect(body).toMatchObject({ model: "gpt-image-2", async: true, response_format: "url", size: "2048x1152", quality });
        expect(decodeURIComponent(calls.at(-1)!.url)).toContain("/v1/images/generations");
    }
});
test("explicit pixel dimensions are preserved", async () => {
    await createImageGenerationTask({ ...config(), size: "1024x1024", quality: "max" }, "test");
    expect(calls[0].body.size).toBe("1024x1024");
});
test("auto resolution does not infer dimensions from quality", async () => {
    await createImageGenerationTask({ ...config(), size: "auto", resolution: "auto", quality: "max" }, "test");
    expect(calls[0].body).not.toHaveProperty("size");
});
test("plain task_id is recognized and the same model is used for polling", async () => {
    respond = (method) => method === "POST" ? { status: "queued", task_id: "5626d8d752c945b98128be6629eba689" } : { status: "succeeded", data: { data: [{ url: "https://media.example.com/result.png" }] } };
    const cfg = config();
    const result = await createImageGenerationTask(cfg, "test");
    expect(result.mode).toBe("task");
    if (result.mode !== "task") throw new Error("task expected");
    expect(result.task.id).toBe("5626d8d752c945b98128be6629eba689");
    const state = await pollImageGenerationTask(cfg, result.task);
    expect(state.status).toBe("completed");
});
test("multipart retains image[] binaries and a real mask file, no DAV upload", async () => {
    const ref = { id: "a", name: "a.png", type: "image/png", dataUrl: png };
    const cfg = config();
    cfg.channels[0].referenceImageRequestFormat = "form-data";
    cfg.channels[0].imageResponseFormat = "b64_json";
    await createImageGenerationTask(cfg, "test", [ref, { ...ref, id: "b" }], ref);
    const body = calls[0].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.getAll("image[]")).toHaveLength(2);
    expect(body.get("mask")).toBeInstanceOf(File);
    expect(body.get("response_format")).toBe("b64_json");
    expect(body.get("async")).toBe("true");
    expect(body.get("quality")).toBe("high");
    expect(publicUploads).toBe(0);
});
test("JSON reference URLs refresh each request and deduplicate within a request", async () => {
    const ref = { id: "a", name: "a.png", type: "image/png", storageKey: "image:test", dataUrl: png };
    await createImageGenerationTask(config(), "first", [ref, ref]);
    expect(publicUploads).toBe(1);
    expect(calls[0].body.images).toEqual([{ image_url: "https://media.example.com/ref-1.png" }, { image_url: "https://media.example.com/ref-1.png" }]);
    await createImageGenerationTask(config(), "second", [ref]);
    expect(publicUploads).toBe(2);
    expect(calls[1].body.images[0].image_url).toBe("https://media.example.com/ref-2.png");
});
test("Gemini imageSize is sent for arbitrary image models", async () => {
    respond = () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.split(",")[1] } }] } }] });
    await createImageGenerationTask(config("image", "gemini", "nano-banana-2.1"), "test");
    expect(calls[0].body.generationConfig.imageConfig).toMatchObject({ aspectRatio: "16:9", imageSize: "2K" });
});
test("content refusal shows the upstream cause without protocol or sync retries", async () => {
    const reason = "提示内容不符合上游政策";
    respond = () => ({ finalResponse: { status: "succeeded", outcome: "content_refused", result: { data: [], refusal: reason, message: reason } } });
    await expect(createImageGenerationTask(config(), "test")).rejects.toThrow(reason);
    expect(calls).toHaveLength(1);
});
test("OpenAI video retains JSON numeric duration and original aspect_ratio", async () => {
    respond = () => ({ id: "video-task" });
    await createVideoGenerationTask({ ...config("video"), videoSeconds: "12", vquality: "1080p" }, "test");
    expect(calls[0].body).toMatchObject({ model: "video-model", duration: 12, aspect_ratio: "16:9", resolution: "1080p" });
    expect(calls[0].body).not.toHaveProperty("first_frame");
});
test("OpenAI multipart uses resolution and records the actual field name", async () => {
    respond = () => ({ id: "video-task" });
    for (const [quality, resolution] of [["1080p", "1080p"], ["720p", "720p"], ["auto", "720p"]]) {
        const cfg = config("video");
        cfg.channels[0].referenceImageRequestFormat = "form-data";
        const task = await createVideoGenerationTask({ ...cfg, vquality: quality }, "test");
        const body = calls.at(-1)!.body as FormData;
        expect(body.get("resolution")).toBe(resolution);
        expect(body.has("resolution_name")).toBe(false);
        expect(task.logParams).toMatchObject({ resolution });
        expect(task.logParams).not.toHaveProperty("resolution_name");
    }
});

test("OpenAI JSON reference upload fallback retains resolution in multipart", async () => {
    respond = () => ({ id: "video-task" });
    globalThis.fetch = mock(async () => { throw new Error("DAV unavailable"); }) as typeof fetch;
    const ref = { id: "a", name: "a.png", type: "image/png", dataUrl: png };
    const task = await createVideoGenerationTask({ ...config("video"), vquality: "1080p" }, "test", [ref]);
    const body = calls.at(-1)!.body as FormData;
    expect(body.get("resolution")).toBe("1080p");
    expect(body.has("resolution_name")).toBe(false);
    expect(body.get("input_reference[]")).toBeInstanceOf(File);
    expect(task.logParams).toMatchObject({ resolution: "1080p" });
});

test("OpenAI explicit frame mode adds URLs without removing legacy fields", async () => {
    respond = () => ({ id: "video-task" });
    const ref = { id: "a", name: "a.png", type: "image/png", storageKey: "image:a", dataUrl: png };
    await createVideoGenerationTask({ ...config("video"), videoMode: "frames" }, "test", [ref]);
    expect(calls[0].body).toMatchObject({ duration: 6, mode: "frames", first_frame: "https://media.example.com/ref-1.png", images: ["https://media.example.com/ref-1.png"] });
});
test("MiniMax remains independently routed", async () => {
    respond = () => ({ task_id: "minimax-task" });
    const task = await createVideoGenerationTask(config("video", "minimax", "minimax_h3"), "test");
    expect(task.provider).toBe("minimax");
    expect(decodeURIComponent(calls[0].url)).toContain("/v1/videos");
    expect(defaultConfig.videoWorkflowId).toBe("none");
    expect(calls[0].body).not.toHaveProperty("workflow_id");
});
test("MiniMax accepts id and task_id in direct or nested task responses", async () => {
    const responses = [
        { id: "direct-id", status: "succeeded", result_url: "https://media.example.com/video.mp4" },
        { data: { id: "data-id", status: "succeeded", result_url: "https://media.example.com/video.mp4" } },
        { data: { task: { id: "nested-task-id", status: "succeeded", result_url: "https://media.example.com/video.mp4" } } },
        { result: { task_id: "nested-task-id-field" } },
        { message: JSON.stringify({ id: "message-json-id", object: "video", status: "queued" }) },
    ];
    for (const response of responses) {
        respond = () => response;
        const task = await createVideoGenerationTask(config("video", "minimax", "minimax_h3"), "test");
        expect(task.id).toBe(response.id || response.data?.id || response.data?.task?.id || response.result?.task_id || "message-json-id");
    }
});
test("MiniMax parses message JSON task IDs and accepts the completed result URL", async () => {
    const cfg = config("video", "minimax", "minimax_h3");
    respond = (method) => method === "POST"
        ? { message: JSON.stringify({ id: "task_71fae039-38d3-4204-82e1-a501b29d8486", object: "video", model: "minimax-h3", status: "queued", progress: 0, created_at: 1794501702, result_url: null, error: null }) }
        : { id: "52058ecb-48ee-4044-8273-b6fd32f36e2a", error: null, model: "minimax-h3", status: "succeeded", progress: 100, created_at: "2026-11-12T16:30:30.984621+00:00", result_url: "https://xysnai.cn/v1/videos/public/task_52058ecb-48ee-4044-8273-b6fd32f36e2a", completed_at: "2026-11-12T16:32:27.049608+00:00" };
    for (const format of ["json", "form-data"] as const) {
        cfg.channels[0].referenceImageRequestFormat = format;
        const task = await createVideoGenerationTask(cfg, "test");
        expect(task.id).toBe("task_71fae039-38d3-4204-82e1-a501b29d8486");
        const result = await pollVideoGenerationTask(cfg, task);
        expect(result).toMatchObject({ status: "completed", result: { url: "https://xysnai.cn/v1/videos/public/task_52058ecb-48ee-4044-8273-b6fd32f36e2a", mimeType: "video/mp4" } });
        expect(result.status === "completed" && result.result.responseResult).toEqual({ id: "52058ecb-48ee-4044-8273-b6fd32f36e2a", error: null, model: "minimax-h3", status: "succeeded", progress: 100, created_at: "2026-11-12T16:30:30.984621+00:00", result_url: "https://xysnai.cn/v1/videos/public/task_52058ecb-48ee-4044-8273-b6fd32f36e2a", completed_at: "2026-11-12T16:32:27.049608+00:00" });
    }
});
test("MiniMax no workflow omits the field in JSON and multipart even for high resolution models", async () => {
    respond = () => ({ task_id: "minimax-task" });
    for (const format of ["json", "form-data"] as const) {
        for (const workflow of ["none", ""] as const) {
            for (const model of ["minimax_h3", "minimax_h3_2K", "minimax_h3_4K"]) {
                const cfg = { ...config("video", "minimax", model), videoWorkflowId: workflow, supportsWorkflowId: true };
                cfg.channels[0].supportsWorkflowId = true;
                cfg.channels[0].referenceImageRequestFormat = format;
                const task = await createVideoGenerationTask(cfg, "test", [{ id: "ref", name: "ref.png", type: "image/png", dataUrl: png }]);
                const body = calls.at(-1)!.body;
                if (body instanceof FormData) expect(body.has("workflow_id")).toBe(false);
                else expect(body).not.toHaveProperty("workflow_id");
                expect(task.logParams).not.toHaveProperty("workflow_id");
            }
        }
    }
});
test("MiniMax explicit automatic and selected workflows retain their existing request behavior", async () => {
    respond = () => ({ task_id: "minimax-task" });
    for (const format of ["json", "form-data"] as const) {
        for (const [workflow, model, expected] of [["auto", "minimax_h3", "text-to-video"], ["auto", "minimax_h3_4K", "cf-multi-reference"], ["cf-mj", "minimax_h3_4K", "cf-mj"], ["fl2v", "minimax_h3", "fl2v"]]) {
            const cfg = { ...config("video", "minimax", model), videoWorkflowId: workflow, supportsWorkflowId: true };
            cfg.channels[0].supportsWorkflowId = true;
            cfg.channels[0].referenceImageRequestFormat = format;
            await createVideoGenerationTask(cfg, "test");
            const body = calls.at(-1)!.body;
            expect(body instanceof FormData ? body.get("workflow_id") : body.workflow_id).toBe(expected);
        }
    }
});
test("Gemini native video creates and polls an operation through the server proxy", async () => {
    respond = (method) => method === "POST" ? { name: "operations/test-video" } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://media.example.com/video.mp4" } }] } } };
    const cfg = { ...config("video", "gemini", "veo-test"), videoMode: "frames" };
    const task = await createVideoGenerationTask(cfg, "test", [{ id: "a", name: "a.png", type: "image/png", dataUrl: png }]);
    expect(task.provider).toBe("gemini");
    expect(calls[0].url.startsWith("/api/ai-proxy?")).toBe(true);
    expect(calls[0].body.instances[0].image.mimeType).toBe("image/png");
    const state = await pollVideoGenerationTask(cfg, task);
    expect(state.status).toBe("completed");
    if (state.status === "completed") expect(state.result.url).toContain("https://media.example.com/video.mp4");
});
test("group inputs retain all connected images and text when there is no explicit mention", () => {
    const image = { id: "a", name: "a.png", type: "image/png", dataUrl: png };
    const base = { position: { x: 0, y: 0 }, width: 100, height: 100 };
    const nodes = [
        { ...base, id: "target", type: "config", title: "target", metadata: { composerContent: "test" } },
        { ...base, id: "group", type: "group", title: "group" },
        { ...base, id: "image", type: "image", title: "a", metadata: { content: png, groupId: "group", mimeType: "image/png" } },
        { ...base, id: "text", type: "text", title: "text", metadata: { content: "group text", groupId: "group" } },
    ];
    const context = buildNodeGenerationContext("target", nodes as any, [{ id: "edge", fromNodeId: "group", toNodeId: "target" }], "test");
    expect(context.referenceImages).toHaveLength(1);
    expect(context.prompt).toContain("group text");
});
test("every inserted script template compiles", () => {
    for (const templates of Object.values(getPluginTemplates())) for (const item of templates) expect(() => new Function(`return (async () => { ${item.script} })();`)).not.toThrow();
});

test("removed channels cannot reach the transport even outside the UI readiness check", async () => {
    const cfg = { ...config(), model: "deleted::gpt-image-2" };
    await expect(createImageGenerationTask(cfg, "test")).rejects.toThrow("不可用");
    expect(calls).toHaveLength(0);
});
test("removed channels cannot be used to recover video tasks", async () => {
    const cfg = { ...config("video"), model: "deleted::video-model" };
    await expect(pollVideoGenerationTask(cfg, { id: "old-task", provider: "openai", model: "video-model", createdAt: 0 })).rejects.toThrow("不可用");
    expect(calls).toHaveLength(0);
});

test("finished image task failures and permanent HTTP errors stop polling with the actual reason", async () => {
    const cfg = config();
    const task = { id: "finished-task", provider: "openai", model: cfg.model } as Parameters<typeof pollImageGenerationTask>[1];
    respond = () => ({ status: "failed", error: { message: "图片内容被拒绝" } });
    const failed = await pollImageGenerationTask(cfg, task);
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") expect(failed.error).toBe("图片内容被拒绝");
    for (const status of [401, 404, 410]) {
        respond = () => { throw { isAxiosError: true, response: { status, data: { message: status === 410 ? "资源已被清理" : "任务查询被拒绝" } } }; };
        const state = await pollImageGenerationTask(cfg, task);
        expect(state.status).toBe("failed");
        if (state.status === "failed") expect(state.error).toBe(status === 410 ? "资源已被清理" : "任务查询被拒绝");
    }
});
test("temporary image task query failures remain retryable instead of becoming terminal failures", async () => {
    const cfg = config();
    const task = { id: "running-task", provider: "openai", model: cfg.model } as Parameters<typeof pollImageGenerationTask>[1];
    for (const status of [429, 502, 503]) {
        respond = () => { throw { isAxiosError: true, response: { status, data: { message: "temporary failure" } } }; };
        await expect(pollImageGenerationTask(cfg, task)).rejects.toThrow("temporary failure");
    }
});
