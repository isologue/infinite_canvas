import type { PromptSource } from "./prompt-source-presets";

export type RawPrompt = {
    id: string;
    stableId?: string;
    title: string;
    prompt: string;
    description: string;
    coverUrl: string;
    referenceImageUrls: string[];
    tags: string[];
    preview: string;
    createdAt: string;
    updatedAt: string;
    author?: string;
    sourceUrl?: string;
    imageMode?: string;
    imageModel?: string;
    imageSize?: string;
    imageCount?: number;
};

export function parsePromptSourceData(data: unknown, source: PromptSource) {
    if (!Array.isArray(data)) throw new Error(`提示词来源 ${source.name} 的 JSON 根节点必须是数组`);
    const seen = new Set<string>();
    const items: RawPrompt[] = [];
    data.forEach((value, index) => {
        const record = asRecord(value);
        const title = stringValue(record.title).trim();
        const prompt = stringValue(record.prompt).trim();
        if (!title || !prompt) return;
        const stableId = stringValue(record.id).trim();
        const id = stableId || `${source.id}-${leftPad(index + 1)}`;
        if (seen.has(id)) return;
        seen.add(id);
        const referenceImageUrls = stringArray(record.referenceImageUrls).map((url) => absoluteUrl(source.url, url));
        const coverUrl = absoluteUrl(source.url, stringValue(record.coverUrl)) || referenceImageUrls[0] || "";
        items.push({
            id,
            stableId: stableId || undefined,
            title,
            prompt,
            description: stringValue(record.description),
            coverUrl,
            referenceImageUrls,
            tags: stringArray(record.tags),
            preview: stringValue(record.preview),
            createdAt: stringValue(record.createdAt),
            updatedAt: stringValue(record.updatedAt),
            author: optionalString(record.author),
            sourceUrl: optionalString(absoluteUrl(source.url, stringValue(record.sourceUrl))),
            imageMode: optionalString(record.imageMode),
            imageModel: optionalString(record.imageModel),
            imageSize: optionalString(record.imageSize),
            imageCount: optionalNumber(record.imageCount),
        });
    });
    return items;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function stringValue(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(stringValue).map((item) => item.trim()).filter(Boolean) : []; }
function optionalString(value: unknown) { const result = stringValue(value).trim(); return result || undefined; }
function optionalNumber(value: unknown) { const result = Number(value); return Number.isFinite(result) && result > 0 ? result : undefined; }
function absoluteUrl(baseUrl: string, path: string) {
    if (!path) return "";
    try { return new URL(path, baseUrl).toString(); } catch { return path; }
}
function leftPad(value: number) { return String(value).padStart(4, "0"); }