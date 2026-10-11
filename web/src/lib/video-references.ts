import i18n from "@/i18n";

export const VIDEO_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 200 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
};

export const VIDEO_REFERENCE_MIME_TYPES = ["video/mp4", "video/quicktime"];

export function videoReferenceLabel(kind: "image" | "video" | "audio", index: number) {
    return i18n.t(`videoReferences.${kind}`, { index: index + 1 });
}
