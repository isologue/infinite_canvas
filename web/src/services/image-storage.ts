"use client";

import localforage from "localforage";

import { nanoid } from "nanoid";
import { createImageThumbnail } from "@/lib/image-thumbnail";

import { resolveImageMimeType } from "@/lib/image-mime";
import { compressImageIfLarge, readImageMeta } from "@/lib/image-utils";
import { storageFileUrl } from "@/services/storage-url";
import { markUploadProcessing, trackResourceUpload, uploadResourceFile, type ResourceUploadOptions } from "@/services/api/resource-upload";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};


const objectUrls = new Map<string, string>();

const previewStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_previews" });
const previewUrls = new Map<string, string>();
const previewListeners = new Set<() => void>();
const previewPending = new Set<string>();
let previewRevision = 0;
let previewQueue: Promise<unknown> = Promise.resolve();
const IMAGE_PREVIEW_VERSION = 1;
type StoredImagePreview = { version: number; blob?: Blob };

export async function uploadImage(input: string | Blob, options?: ResourceUploadOptions & { compress?: boolean }): Promise<UploadedImage> {
    options = { ...options, source: options?.source || (input instanceof File ? "upload" : "generated") };
    return trackResourceUpload(input, "image", options, async (uploadId) => {
        if (typeof input === "string" && /^https?:\/\//i.test(input)) {
            markUploadProcessing(uploadId);
            return importImageFromServer(input, options);
        }
        const raw = await normalizeImageBlobMimeType(typeof input === "string" ? await (await fetch(input)).blob() : input);
        // 仅对用户上传的大图压缩（超过 10MB 等比缩放重编码）；生成结果不传 compress，保持原图。
        const blob = options?.compress ? await compressImageIfLarge(raw) : raw;
        const storageKey = `image:${nanoid()}`;
        const localUrl = URL.createObjectURL(blob);
        try {
            const meta = await readImageMeta(localUrl);
            await uploadFile(storageKey, blob, {
                ...options,
                metadata: { ...(options?.metadata || {}), width: meta.width, height: meta.height, mimeType: blob.type || meta.mimeType, bytes: blob.size },
            }, uploadId);
            objectUrls.set(storageKey, localUrl);
            void storeImagePreview(storageKey, blob);
            return { url: localUrl, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
        } catch (error) {
            URL.revokeObjectURL(localUrl);
            throw error;
        }
    });
}

async function importImageFromServer(url: string, options?: ResourceUploadOptions): Promise<UploadedImage> {
    const response = await fetch("/api/storage/images/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title: options?.title, source: options?.source, metadata: options?.metadata }),
    });
    const payload = (await response.json().catch(() => null)) as {
        code?: number;
        msg?: string;
        data?: { storageKey?: string; bytes?: number; mimeType?: string; width?: number; height?: number; url?: string };
    } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data?.storageKey) throw new Error(payload?.msg || `图片服务端转存失败（HTTP ${response.status}）`);
    return {
        storageKey: payload.data.storageKey,
        bytes: Number(payload.data.bytes || 0),
        mimeType: payload.data.mimeType || "image/png",
        width: Number(payload.data.width || 1024),
        height: Number(payload.data.height || 1024),
        url: storageFileUrl(payload.data.storageKey),
    };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    void ensureImagePreview(storageKey);
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    return storageFileUrl(storageKey);
}

export async function getImageBlob(storageKey: string) {
    return downloadFile(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob, options?: ResourceUploadOptions) {
    return trackResourceUpload(blob, "image", options, async (uploadId) => {
        const normalized = await normalizeImageBlobMimeType(blob);
        await deleteImagePreview(storageKey);
        await uploadFile(storageKey, normalized, options, uploadId);
        const url = URL.createObjectURL(normalized);
        objectUrls.set(storageKey, url);
        void storeImagePreview(storageKey, normalized);
        return url;
    });
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = await resolveImageUrl(image.storageKey, image.dataUrl || image.url || "");
    if (!url) return url;
    if (url.startsWith("data:")) return normalizeImageDataUrlMimeType(url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取参考图失败（HTTP ${response.status}）`);
    return blobToDataUrl(await normalizeImageBlobMimeType(await response.blob()));
}

export async function ensurePublicImageUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    if (image.storageKey) {
        const response = await fetch("/api/storage/images/public-url", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ storageKey: image.storageKey }),
        });
        const payload = await response.json().catch(() => null) as { code?: number; msg?: string; data?: { url?: string } } | null;
        const url = payload?.data?.url || "";
        if (!response.ok || payload?.code !== 0 || !/^https?:\/\//i.test(url)) throw new Error(payload?.msg || "参考图无法转为公网 URL");
        return url;
    }
    const directUrl = image.url || image.dataUrl || "";
    if (/^https?:\/\//i.test(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    if (!directUrl) throw new Error("参考图读取失败，请重新上传");
    const uploaded = await uploadImage(directUrl, { source: "reference-upload" });
    return ensurePublicImageUrl(uploaded);
}

export function createPublicImageUrlResolver() {
    const urls = new Map<string, Promise<string>>();
    return (image: { url?: string; dataUrl?: string; storageKey?: string }) => {
        const key = image.storageKey || image.dataUrl || image.url || "";
        const cached = urls.get(key);
        if (cached) return cached;
        const request = ensurePublicImageUrl(image);
        urls.set(key, request);
        return request;
    };
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
    await Promise.all(Array.from(new Set(keys)).map(deleteImagePreview));
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

async function uploadFile(storageKey: string, blob: Blob, options: ResourceUploadOptions | undefined, uploadId: string | undefined) {
    await uploadResourceFile(storageKey, blob, options, uploadId);
    // 公网地址只供上游引用；页面预览始终读取本地 Blob 或本站存储。
}

async function downloadFile(storageKey: string) {
    const response = await fetch(`/api/storage/files/${encodeURIComponent(storageKey)}`, { cache: "no-store" }).catch(() => null);
    if (!response || !response.ok) return null;
    return response.blob();
}

async function normalizeImageBlobMimeType(blob: Blob) {
    const mimeType = resolveImageMimeType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()), blob.type);
    return mimeType && mimeType !== blob.type ? new Blob([blob], { type: mimeType }) : blob;
}

function normalizeImageDataUrlMimeType(dataUrl: string) {
    const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    if (!match) return dataUrl;
    try {
        const binary = atob(match[2].slice(0, 64));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const mimeType = resolveImageMimeType(bytes, match[1]);
        return mimeType && mimeType !== match[1] ? `data:${mimeType};base64,${match[2]}` : dataUrl;
    } catch {
        return dataUrl;
    }
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

// 缩略图按图片的 storageKey 另存一份 WebP，只放在本地 IndexedDB 里，不写进节点数据，也不参与导出和 WebDAV 同步。
export function previewUrlFor(storageKey?: string) {
    return storageKey ? previewUrls.get(storageKey) : undefined;
}

// 缩略图在后台补，生成完成后再让用到它的界面重渲染一次。
export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

export async function ensureImagePreview(storageKey?: string) {
    if (!storageKey) return undefined;
    const cached = previewUrls.get(storageKey);
    if (cached) return cached;
    const stored = await previewStore.getItem<StoredImagePreview>(storageKey).catch(() => null);
    if (stored?.version === IMAGE_PREVIEW_VERSION) return stored.blob ? cacheImagePreview(storageKey, stored.blob) : undefined;
    queueImagePreview(storageKey);
    return undefined;
}

// 缩略图生成排成一队，避免一次打开大量图片时同时解码。
function queueImagePreview(storageKey: string) {
    if (previewPending.has(storageKey)) return;
    previewPending.add(storageKey);
    previewQueue = previewQueue
        .then(async () => {
            const original = await getImageBlob(storageKey);
            if (original) await storeImagePreview(storageKey, original);
        })
        .catch(() => undefined)
        .finally(() => previewPending.delete(storageKey));
}

async function storeImagePreview(storageKey: string, original: Blob) {
    const preview = await createImageThumbnail(original).catch(() => undefined);
    await previewStore.setItem<StoredImagePreview>(storageKey, { version: IMAGE_PREVIEW_VERSION, blob: preview }).catch(() => undefined);
    return preview ? cacheImagePreview(storageKey, preview) : undefined;
}

function cacheImagePreview(storageKey: string, preview: Blob) {
    const cached = previewUrls.get(storageKey);
    if (cached) return cached;
    const url = URL.createObjectURL(preview);
    previewUrls.set(storageKey, url);
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
    return url;
}

async function deleteImagePreview(storageKey: string) {
    const url = previewUrls.get(storageKey);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(storageKey);
    await previewStore.removeItem(storageKey).catch(() => undefined);
}
