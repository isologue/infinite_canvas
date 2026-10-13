"use client";

import { nanoid } from "nanoid";
import { storageFileUrl } from "@/services/storage-url";
import { markUploadProcessing, trackResourceUpload, uploadResourceFile } from "@/services/api/resource-upload";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const objectUrls = new Map<string, string>();
const publicUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: { title?: string; source?: string }): Promise<UploadedFile> {
    const kind = prefix.startsWith("video") ? "video" : prefix.startsWith("audio") ? "audio" : "file";
    return trackResourceUpload(input, kind, options, async (uploadId) => {
        if (typeof input === "string" && /^https?:\/\//i.test(input) && kind !== "file") {
            markUploadProcessing(uploadId);
            return importMediaFromServer(input, kind, options);
        }
        const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
        const storageKey = `${prefix}:${nanoid()}`;
        await uploadResourceFile(storageKey, blob, options, uploadId);
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
        return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
    });
}

async function importMediaFromServer(url: string, kind: "video" | "audio", options?: { title?: string; source?: string }): Promise<UploadedFile> {
    const response = await fetch(`/api/storage/${kind}s/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title: options?.title, source: options?.source }),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: { storageKey?: string; bytes?: number; mimeType?: string; url?: string } } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data?.storageKey) throw new Error(payload?.msg || `${kind === "video" ? "视频" : "音频"}服务端转存失败（HTTP ${response.status}）`);
    if (payload.data.url) publicUrls.set(payload.data.storageKey, payload.data.url);
    return {
        storageKey: payload.data.storageKey,
        bytes: Number(payload.data.bytes || 0),
        mimeType: payload.data.mimeType || (kind === "video" ? "video/mp4" : "audio/mpeg"),
        url: storageFileUrl(payload.data.storageKey),
    };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    return storageFileUrl(storageKey);
}

export async function getMediaBlob(storageKey: string) {
    return downloadFile(storageKey);
}

export async function ensurePublicMediaUrl(media: { storageKey?: string; url?: string }) {
    if (media.storageKey) {
        const cached = publicUrls.get(media.storageKey);
        if (cached) return cached;
        const response = await fetch("/api/storage/files/public-url", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ storageKey: media.storageKey }),
        });
        const payload = await response.json().catch(() => null) as { code?: number; msg?: string; data?: { url?: string } } | null;
        const url = payload?.data?.url || "";
        if (!response.ok || payload?.code !== 0 || !/^https?:\/\//i.test(url)) throw new Error(payload?.msg || "参考素材无法转为公网 URL");
        publicUrls.set(media.storageKey, url);
        return url;
    }
    if (/^https?:\/\//i.test(media.url || "")) return media.url!;
    throw new Error("参考素材读取失败，请重新上传");
}

export async function setMediaBlob(storageKey: string, blob: Blob, options?: { title?: string; source?: string }) {
    const kind = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
    return trackResourceUpload(blob, kind, options, async (uploadId) => {
        await uploadResourceFile(storageKey, blob, options, uploadId);
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        return url;
    });
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    void keys;
}

export async function cleanupUnusedMedia(usedData: unknown) {
    void usedData;
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

async function downloadFile(storageKey: string) {
    const response = await fetch(`/api/storage/files/${encodeURIComponent(storageKey)}`, { cache: "no-store" }).catch(() => null);
    if (!response || !response.ok) return null;
    return response.blob();
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            video.removeAttribute("src");
            video.load();
            resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        };
        const timeout = window.setTimeout(done, 2_000);
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            audio.removeAttribute("src");
            audio.load();
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        const timeout = window.setTimeout(done, 2_000);
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
