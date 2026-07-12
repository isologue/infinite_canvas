"use client";

import { nanoid } from "nanoid";
import { storageFileUrl } from "@/services/storage-url";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: { title?: string; source?: string }): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await uploadFile(storageKey, blob, options);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
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

export async function setMediaBlob(storageKey: string, blob: Blob, options?: { title?: string; source?: string }) {
    await uploadFile(storageKey, blob, options);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
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

async function uploadFile(storageKey: string, blob: Blob, options?: { title?: string; source?: string }) {
    const arrayBuffer = await blob.arrayBuffer();
    const response = await fetch("/api/storage/files", {
        method: "POST",
        headers: {
            "content-type": "application/octet-stream",
            "x-storage-key": storageKey,
            "x-storage-mime-type": blob.type || "application/octet-stream",
            "x-resource-title": encodeURIComponent(options?.title || ""),
            "x-resource-source": options?.source || "upload",
        },
        body: arrayBuffer,
    });
    if (!response.ok) throw new Error("文件保存失败");
}

async function downloadFile(storageKey: string) {
    const response = await fetch(`/api/storage/files/${encodeURIComponent(storageKey)}`, { cache: "no-store" }).catch(() => null);
    if (!response || !response.ok) return null;
    return response.blob();
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
