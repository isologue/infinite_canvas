"use client";

import { nanoid } from "nanoid";

import { compressImageIfLarge, readImageMeta } from "@/lib/image-utils";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob, options?: { compress?: boolean }): Promise<UploadedImage> {
    const raw = typeof input === "string" ? await (await fetch(input)).blob() : input;
    // 仅对用户上传的大图压缩（超过 10MB 等比缩放重编码）；生成结果不传 compress，保持原图。
    const blob = options?.compress ? await compressImageIfLarge(raw) : raw;
    const storageKey = `image:${nanoid()}`;
    await uploadFile(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await downloadFile(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return downloadFile(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await uploadFile(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    const list = Array.from(new Set(keys));
    await Promise.all(
        list.map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
        }),
    );
    await fetch("/api/storage/files", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: list }),
    }).catch(() => null);
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = Array.from(collectImageStorageKeys(usedData));
    await fetch("/api/storage/files/cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usedKeys, prefixes: ["image:"] }),
    }).catch(() => null);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

async function uploadFile(storageKey: string, blob: Blob) {
    const arrayBuffer = await blob.arrayBuffer();
    await fetch("/api/storage/files", {
        method: "POST",
        headers: {
            "content-type": "application/octet-stream",
            "x-storage-key": storageKey,
            "x-storage-mime-type": blob.type || "application/octet-stream",
        },
        body: arrayBuffer,
    });
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
