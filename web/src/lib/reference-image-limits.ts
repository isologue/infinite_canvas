import type { ReferenceImage } from "@/types/image";

export const MAX_REFERENCE_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_REFERENCE_IMAGES_BYTES = 50 * 1024 * 1024;

export function formatReferenceImageBytes(bytes: number) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function referenceImageFileError(file: Pick<Blob, "size"> & { name?: string }, currentTotalBytes = 0) {
    const name = file.name || "参考图";
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) return `${name} 为 ${formatReferenceImageBytes(file.size)}，超过单张 15MB 限制`;
    if (currentTotalBytes + file.size > MAX_REFERENCE_IMAGES_BYTES) return `参考图总大小将达到 ${formatReferenceImageBytes(currentTotalBytes + file.size)}，超过 50MB 限制`;
    return "";
}

export async function referenceImageBytes(image: ReferenceImage) {
    if (Number.isFinite(image.bytes) && Number(image.bytes) > 0) return Number(image.bytes);
    if (image.dataUrl?.startsWith("data:")) return dataUrlByteSize(image.dataUrl);
    if (!image.dataUrl) return 0;
    try {
        return (await fetch(image.dataUrl)).blob().then((blob) => blob.size);
    } catch {
        return 0;
    }
}

export async function referenceImagesError(images: ReferenceImage[]) {
    const sizes = await Promise.all(images.map(async (image) => ({ image, bytes: await referenceImageBytes(image) })));
    const oversized = sizes.find(({ bytes }) => bytes > MAX_REFERENCE_IMAGE_BYTES);
    if (oversized) return `${oversized.image.name || "参考图"} 为 ${formatReferenceImageBytes(oversized.bytes)}，超过单张 15MB 限制`;
    const total = sizes.reduce((sum, item) => sum + item.bytes, 0);
    return total > MAX_REFERENCE_IMAGES_BYTES ? `参考图总大小为 ${formatReferenceImageBytes(total)}，超过 50MB 限制` : "";
}

function dataUrlByteSize(dataUrl: string) {
    const base64 = dataUrl.split(",", 2)[1] || "";
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
