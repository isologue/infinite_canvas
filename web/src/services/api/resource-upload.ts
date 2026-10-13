"use client";

import axios from "axios";

import { useUploadStore, type UploadKind } from "@/stores/use-upload-store";

export type ResourceUploadOptions = { title?: string; source?: string; metadata?: Record<string, unknown> };

const kindNames: Record<UploadKind, string> = { image: "图片", video: "视频", audio: "音频", file: "文件" };

export async function trackResourceUpload<T>(input: string | Blob, kind: UploadKind, options: ResourceUploadOptions | undefined, operation: (id: string) => Promise<T>): Promise<T> {
    const name = options?.title || (input instanceof File ? input.name : "") || `未命名${kindNames[kind]}`;
    const store = useUploadStore.getState();
    const id = store.start(name, kind, input instanceof Blob ? input.size : 0);
    try {
        const result = await operation(id);
        store.update(id, { status: "success", progress: 100, ...(result && typeof result === "object" && "bytes" in result && typeof result.bytes === "number" ? { bytes: result.bytes } : {}) });
        return result;
    } catch (error) {
        store.update(id, { status: "error", error: error instanceof Error ? error.message : "上传失败，请重试" });
        throw error;
    }
}

export function markUploadProcessing(id: string) {
    useUploadStore.getState().update(id, { status: "processing" });
}

export async function uploadResourceFile(storageKey: string, blob: Blob, options: ResourceUploadOptions | undefined, uploadId: string) {
    const update = useUploadStore.getState().update;
    update(uploadId, { status: "uploading", bytes: blob.size });
    const response = await axios.post<{ code?: number; msg?: string; data?: { url?: string } }>("/api/storage/files", blob, {
        adapter: "xhr",
        headers: {
            "content-type": "application/octet-stream",
            "x-storage-key": storageKey,
            "x-storage-mime-type": blob.type || "application/octet-stream",
            "x-resource-title": encodeURIComponent(options?.title || ""),
            "x-resource-source": options?.source || "upload",
            "x-resource-metadata": encodeURIComponent(JSON.stringify(options?.metadata || {})),
        },
        onUploadProgress: ({ loaded, total }) => {
            const bytes = total || blob.size;
            const progress = bytes ? Math.min(100, Math.floor(loaded / bytes * 100)) : 0;
            update(uploadId, { progress, status: loaded >= bytes && bytes > 0 ? "processing" : "uploading" });
        },
        validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300 || response.data?.code !== 0) {
        throw new Error(response.data?.msg || (response.status === 413 ? "资源过大，请检查上传大小限制（HTTP 413）" : `资源上传失败（HTTP ${response.status}）`));
    }
    markUploadProcessing(uploadId);
    return response.data;
}
