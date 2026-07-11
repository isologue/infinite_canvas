import sharp from "sharp";

import { readUserFile, readUserFileInfo, upsertUserFile } from "@/lib/server/user-data-db";

const PREVIEW_PREFIX = "preview:";
const MAX_SOURCE_BYTES_WITHOUT_PREVIEW = 512 * 1024;
const previewJobs = new Map<string, Promise<{ mimeType: string; content: Buffer } | null>>();

export function imagePreviewStorageKey(storageKey: string) {
    return `${PREVIEW_PREFIX}${storageKey}`;
}

export function getUserImagePreview(userId: string, storageKey: string) {
    const jobKey = `${userId}:${storageKey}`;
    const active = previewJobs.get(jobKey);
    if (active) return active;
    const job = createUserImagePreview(userId, storageKey).finally(() => previewJobs.delete(jobKey));
    previewJobs.set(jobKey, job);
    return job;
}

async function createUserImagePreview(userId: string, storageKey: string) {
    const previewKey = imagePreviewStorageKey(storageKey);
    const [preview, originalInfo] = await Promise.all([readUserFile(userId, previewKey), readUserFileInfo(userId, storageKey)]);
    if (!originalInfo?.mime_type.startsWith("image/")) return null;
    if (preview && new Date(preview.updated_at).getTime() >= new Date(originalInfo.updated_at).getTime()) return { mimeType: preview.mime_type, content: preview.content };

    const original = await readUserFile(userId, storageKey);
    if (!original) return null;
    if (original.content.length <= MAX_SOURCE_BYTES_WITHOUT_PREVIEW) return { mimeType: original.mime_type, content: original.content };

    try {
        const content = await sharp(original.content).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        await upsertUserFile(userId, { storageKey: previewKey, mimeType: "image/webp", bytes: content.length, content });
        return { mimeType: "image/webp", content };
    } catch {
        return { mimeType: original.mime_type, content: original.content };
    }
}
