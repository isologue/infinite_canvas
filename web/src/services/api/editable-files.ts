import axios from "axios";
import { useUploadStore } from "@/stores/use-upload-store";

import { buildAiProxyUrl, buildApiUrl, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { EditableFileKind, EditableFileLog, EditableFileTask, StoredEditableFile } from "@/types/file-generation";

export const FILE_TASK_POLL_INTERVAL_MS = 5_000;
const CREATE_PATH: Record<EditableFileKind, string> = { ppt: "/ppt/generations", psd: "/psd/generations", svg: "/svg/generations" };

export function resolveFileRequestConfig(config: AiConfig, model: string) {
    const resolved = resolveModelRequestConfig(config, model);
    if (resolved.apiFormat !== "openai") throw new Error("文件生成目前要求 OpenAI 兼容渠道");
    if (!resolved.baseUrl.trim() || !resolved.apiKey.trim()) throw new Error("请先配置文件模型渠道和 API Key");
    return resolved;
}

export async function createEditableFileTask(config: AiConfig, model: string, input: { kind: EditableFileKind; prompt: string; clientTaskId: string; images: string[] }) {
    const requestConfig = resolveFileRequestConfig(config, model);
    if (input.kind === "psd" && !input.images.length) throw new Error("PSD 生成至少需要一张参考图");
    const payload = await requestJson<EditableFileTask>(requestConfig, buildApiUrl(requestConfig.baseUrl, CREATE_PATH[input.kind]), {
        model: requestConfig.model,
        prompt: input.prompt,
        client_task_id: input.clientTaskId,
        base64_images: input.images,
    });
    return normalizeEditableFileTask(payload, input.kind);
}

export async function pollEditableFileTask(config: AiConfig, model: string, task: EditableFileTask) {
    const requestConfig = resolveFileRequestConfig(config, model);
    const url = buildApiUrl(requestConfig.baseUrl, `/editable-file-tasks/${encodeURIComponent(task.id)}`);
    return normalizeEditableFileTask(await requestJson<EditableFileTask>(requestConfig, url), task.kind);
}

export async function storeEditableFileResources(logId: string): Promise<EditableFileLog> {
    const response = await axios.post<{ code: number; msg?: string; data?: { log: EditableFileLog } }>("/api/storage/editable-files/import", { logId });
    if (response.data?.code !== 0 || !response.data.data?.log) throw new Error(response.data?.msg || "文件资源转存失败");
    return response.data.data.log;
}

export async function downloadEditableFile(config: AiConfig, model: string, fileUrl: string, filename: string, stored?: StoredEditableFile) {
    let downloadUrl: string;
    if (stored?.storageKey) {
        downloadUrl = `/api/storage/files/${encodeURIComponent(stored.storageKey)}`;
    } else {
        const base = new URL(resolveFileRequestConfig(config, model).baseUrl);
        const url = new URL(fileUrl, base);
        if (url.origin !== base.origin) throw new Error("上游文件链接与当前模型渠道域名不一致");
        downloadUrl = buildAiProxyUrl(url.toString());
    }
    const { start, update, setCollapsed } = useUploadStore.getState();
    const transferId = start(filename, "file", 0, "download");
    setCollapsed(false);
    try {
        update(transferId, { status: "downloading" });
        const response = await axios.get<Blob>(downloadUrl, {
            responseType: "blob",
            onDownloadProgress: ({ loaded, total }) => update(transferId, {
                receivedBytes: loaded, bytes: total || 0, totalKnown: Boolean(total),
                progress: total ? Math.min(100, Math.floor(loaded / total * 100)) : 0,
            }),
        });
        const blob = response.data;
        if (!blob.size) throw new Error("下载到的文件为空");
        if (/application\/json|text\/html/i.test(blob.type)) throw new Error("下载返回了错误页面，未保存文件");
        update(transferId, { status: "processing", progress: 100, bytes: blob.size, receivedBytes: blob.size, totalKnown: true });
        const { saveAs } = await import("file-saver");
        saveAs(blob, filename);
        update(transferId, { status: "success" });
    } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const reason = status === 404 || status === 410 ? "文件已被清理或下载链接已失效" : error instanceof Error ? error.message : "文件下载失败";
        update(transferId, { status: "error", error: reason });
        throw new Error(reason);
    }
}

async function requestJson<T>(config: AiConfig, url: string, data?: unknown): Promise<T> {
    let response;
    try {
        response = await axios.request<{ error?: { message?: string }; msg?: string; message?: string; [key: string]: unknown }>({
            method: data === undefined ? "GET" : "POST",
            url: buildAiProxyUrl(url),
            headers: { Authorization: `Bearer ${config.apiKey}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
            ...(data === undefined ? {} : { data }),
        });
    } catch (error) {
        if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string }>(error)) {
            const payload = error.response?.data;
            if (payload && typeof payload === "object") throw new Error(payload.error?.message || payload.msg || payload.message || `文件任务请求失败（HTTP ${error.response?.status || 0}）`);
            throw new Error(error.response?.status ? `文件任务请求失败（HTTP ${error.response.status}）` : error.message);
        }
        throw error;
    }
    const payload = response.data;
    if (response.status < 200 || response.status >= 300) throw new Error(payload.error?.message || payload.msg || payload.message || `文件任务请求失败（HTTP ${response.status}）`);
    return payload as T;
}

export function normalizeEditableFileTask(task: EditableFileTask, kind = task.kind) {
    const normalizedKind = task.kind || kind;
    const status = task.status;
    if (!task.id || !["queued", "running", "success", "error"].includes(status)) throw new Error("文件任务响应格式无效");
    if (status === "success" && !task.result?.primary_url) throw new Error("文件任务已完成，但没有返回主文件链接");
    if (status === "error" && !task.error?.message) throw new Error(task.error?.code || "文件生成失败");
    return { ...task, taskId: task.taskId || task.id, kind: normalizedKind, created_at: task.created_at || new Date().toISOString(), updated_at: task.updated_at || new Date().toISOString(), elapsed_seconds: Number(task.elapsed_seconds || 0) };
}
