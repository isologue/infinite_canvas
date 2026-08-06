"use client";

import { nanoid } from "nanoid";

import { compressImageIfLarge, readImageMeta } from "@/lib/image-utils";
import { storageFileUrl } from "@/services/storage-url";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob, options?: { compress?: boolean; title?: string; source?: string; metadata?: Record<string, unknown> }): Promise<UploadedImage> {
    const raw = typeof input === "string" ? await (await fetch(input)).blob() : input;
    // 仅对用户上传的大图压缩（超过 10MB 等比缩放重编码）；生成结果不传 compress，保持原图。
    const blob = options?.compress ? await compressImageIfLarge(raw) : raw;
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    const meta = await readImageMeta(url);
    await uploadFile(storageKey, blob, {
        ...options,
        metadata: { ...(options?.metadata || {}), width: meta.width, height: meta.height, mimeType: blob.type || meta.mimeType, bytes: blob.size },
    });
    objectUrls.set(storageKey, url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    return storageFileUrl(storageKey);
}

export async function getImageBlob(storageKey: string) {
    return downloadFile(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob, options?: { title?: string; source?: string }) {
    await uploadFile(storageKey, blob, options);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function createVideoThumbnail(videoUrl: string, title = "??") {
    if (!videoUrl || typeof document === "undefined") return null;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    try {
        const source = new URL(videoUrl, window.location.href);
        if (source.origin !== window.location.origin) video.crossOrigin = "anonymous";
    } catch {
        return null;
    }
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("??????"));
            video.src = videoUrl;
            video.load();
        });
        if (!video.videoWidth || !video.videoHeight) return null;
        const targetWidth = Math.min(video.videoWidth, 960);
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = Math.max(1, Math.round(targetWidth * video.videoHeight / video.videoWidth));
        const time = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(Math.max(video.duration * 0.1, 0.1), Math.max(0, video.duration - 0.01)) : 0;
        if (time > 0) {
            await new Promise<void>((resolve) => {
                video.onseeked = () => resolve();
                video.currentTime = time;
            });
        }
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
        return blob ? uploadImage(blob, { title: `${title}??`, source: "generated-video-cover" }) : null;
    } catch {
        return null;
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

export async function deleteStoredImages(keys: Iterable<string>) {
    void keys;
}

export async function cleanupUnusedImages(usedData: unknown) {
    void usedData;
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

async function uploadFile(storageKey: string, blob: Blob, options?: { title?: string; source?: string; metadata?: Record<string, unknown> }) {
    const arrayBuffer = await blob.arrayBuffer();
    const response = await fetch("/api/storage/files", {
        method: "POST",
        headers: {
            "content-type": "application/octet-stream",
            "x-storage-key": storageKey,
            "x-storage-mime-type": blob.type || "application/octet-stream",
            "x-resource-title": encodeURIComponent(options?.title || ""),
            "x-resource-source": options?.source || "upload",
            "x-resource-metadata": encodeURIComponent(JSON.stringify(options?.metadata || {})),
        },
        body: arrayBuffer,
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { msg?: string } | null;
        throw new Error(payload?.msg || (response.status === 413 ? "参考图超过单张 15MB 限制" : "图片保存失败"));
    }
}

async function downloadFile(storageKey: string) {
    const response = await fetch(`/api/storage/files/${encodeURIComponent(storageKey)}`, { cache: "no-store" }).catch(() => null);
    if (!response || !response.ok) return null;
    return response.blob();
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
