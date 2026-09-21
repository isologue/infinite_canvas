import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveImageMimeType } from "@/lib/image-mime";
import { getPgPool } from "@/lib/server/postgres";
import { countVisiblePrompts, ensurePromptResourceSchema, listDeletedIdentityKeys, markMissingPrompts, readStoredPrompt, touchStoredPrompt, upsertPromptBundle, type PromptImageInput } from "@/lib/server/prompt-resource-db";
import { promptSourceLockKey, readPromptSourceSettings, updatePromptSourceStatus, type PromptSourceStatus } from "@/lib/server/prompt-source-db";
import { parsePromptSourceData, type RawPrompt } from "@/services/api/prompt-source-parser";
import type { PromptSource } from "@/services/api/prompt-source-presets";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export type PromptSourceRefreshResult = PromptSourceStatus & { sourceName: string; success: boolean };
export type PromptSourceRefreshSummary = { results: PromptSourceRefreshResult[]; total: number; successCount: number; failureCount: number };

export async function syncPromptSourceById(sourceId: string): Promise<PromptSourceRefreshResult> {
    const settings = await readPromptSourceSettings();
    const source = settings.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("提示词来源不存在");
    return syncPromptSource(source);
}

export async function syncAllPromptSources() {
    const settings = await readPromptSourceSettings();
    const results = await Promise.all(settings.sources.filter((source) => source.enabled).map(syncPromptSource));
    return summarize(results);
}

export async function syncDuePromptSources() {
    const settings = await readPromptSourceSettings();
    if (!settings.schedule.intervalMinutes) return summarize([]);
    const maxAge = settings.schedule.intervalMinutes * 60_000;
    const due = settings.sources.filter((source) => {
        if (!source.enabled) return false;
        const status = settings.statuses[source.id];
        const lastSuccess = status?.lastSuccessAt ? new Date(status.lastSuccessAt).getTime() : 0;
        return !lastSuccess || Boolean(status?.lastError) || Date.now() - lastSuccess >= maxAge;
    });
    const results = await Promise.all(due.map(syncPromptSource));
    return summarize(results);
}

async function syncPromptSource(source: PromptSource): Promise<PromptSourceRefreshResult> {
    await ensurePromptResourceSchema();
    const db = getPgPool();
    const lockClient = await db.connect();
    const lockKey = promptSourceLockKey(source.id);
    const locked = await lockClient.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [lockKey]);
    if (!locked.rows[0]?.locked) {
        lockClient.release();
        throw new Error(`${source.name} 正在同步，请稍后再试`);
    }
    const syncAt = new Date().toISOString();
    try {
        const data = await fetchSourceJson(source);
        const items = parsePromptSourceData(data, source);
        const tombstones = await listDeletedIdentityKeys(source.id);
        const seen: string[] = [];
        const failures: string[] = [];

        for (const item of items) {
            const identityKey = promptIdentity(item);
            seen.push(identityKey);
            if (tombstones.has(identityKey)) continue;
            const normalized = promptData(item);
            const contentHash = hashJson({ ...normalized, coverUrl: item.coverUrl, referenceImageUrls: item.referenceImageUrls });
            const existing = await readStoredPrompt(source.id, identityKey);
            if (existing?.contentHash === contentHash) {
                await touchStoredPrompt(source.id, identityKey, source.name);
                continue;
            }
            try {
                const images = await downloadPromptImages(item);
                await upsertPromptBundle({
                    sourceId: source.id,
                    sourceName: source.name,
                    promptId: item.stableId || item.id || identityKey,
                    identityKey,
                    title: item.title,
                    sourceUrl: item.sourceUrl || source.homepage,
                    data: normalized,
                    contentHash,
                    images,
                });
            } catch (error) {
                if (existing) await touchStoredPrompt(source.id, identityKey, source.name);
                failures.push(`${item.title}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        await markMissingPrompts(source.id, seen);
        const count = await countVisiblePrompts(source.id);
        const status: PromptSourceStatus = {
            sourceId: source.id,
            count,
            lastSuccessAt: failures.length ? (await readPromptSourceSettings()).statuses[source.id]?.lastSuccessAt || "" : syncAt,
            lastSyncAt: syncAt,
            lastError: failures.slice(0, 5).join("；"),
        };
        await updatePromptSourceStatus(status, true);
        return { ...status, sourceName: source.name, success: !failures.length };
    } catch (error) {
        const settings = await readPromptSourceSettings();
        const previous = settings.statuses[source.id];
        const status: PromptSourceStatus = {
            sourceId: source.id,
            count: previous?.count || 0,
            lastSuccessAt: previous?.lastSuccessAt || "",
            lastSyncAt: syncAt,
            lastError: error instanceof Error ? error.message : String(error),
        };
        await updatePromptSourceStatus(status, true);
        return { ...status, sourceName: source.name, success: false };
    } finally {
        await lockClient.query(`SELECT pg_advisory_unlock($1)`, [lockKey]).catch(() => undefined);
        lockClient.release();
    }
}

async function fetchSourceJson(source: PromptSource) {
    const url = source.url.trim();
    if (!url) throw new Error("JSON URL 不能为空");
    if (url.startsWith("/")) {
        const file = join(process.cwd(), "public", url.replace(/^\/+/, ""));
        return JSON.parse(await readFile(file, "utf8"));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function downloadPromptImages(item: RawPrompt) {
    const inputs: Array<{ role: "cover" | "reference"; index: number; sourceUrl: string }> = [];
    if (item.coverUrl) inputs.push({ role: "cover", index: 0, sourceUrl: item.coverUrl });
    item.referenceImageUrls.forEach((sourceUrl, index) => inputs.push({ role: "reference", index, sourceUrl }));
    return Promise.all(inputs.map(downloadImage));
}

async function downloadImage(input: { role: "cover" | "reference"; index: number; sourceUrl: string }): Promise<PromptImageInput> {
    const localPath = input.sourceUrl.startsWith("/") ? join(process.cwd(), "public", input.sourceUrl.replace(/^\/+/, "")) : "";
    if (localPath) {
        const content = await readFile(localPath);
        if (!content.length) throw new Error("图片内容为空");
        if (content.length > MAX_IMAGE_BYTES) throw new Error("图片超过 25MB");
        const mimeType = resolveImageMimeType(content, "");
        if (!mimeType.startsWith("image/")) throw new Error("资源不是支持的图片格式");
        return { ...input, mimeType, content, contentHash: createHash("sha256").update(content).digest("hex") };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(input.sourceUrl, { cache: "no-store", redirect: "follow", signal: controller.signal });
        if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (declaredLength > MAX_IMAGE_BYTES) throw new Error("图片超过 25MB");
        const content = Buffer.from(await response.arrayBuffer());
        if (!content.length) throw new Error("图片内容为空");
        if (content.length > MAX_IMAGE_BYTES) throw new Error("图片超过 25MB");
        const mimeType = resolveImageMimeType(content, response.headers.get("content-type")?.split(";")[0] || "");
        if (!mimeType.startsWith("image/")) throw new Error("资源不是支持的图片格式");
        return { ...input, mimeType, content, contentHash: createHash("sha256").update(content).digest("hex") };
    } finally {
        clearTimeout(timer);
    }
}

function promptIdentity(item: RawPrompt) {
    return item.stableId?.trim() || item.sourceUrl?.trim() || createHash("sha256").update(`${item.title}\n${item.prompt}`).digest("hex");
}

function promptData(item: RawPrompt): RawPrompt {
    return { ...item, id: item.stableId || item.id, coverUrl: "", referenceImageUrls: [], preview: stripExternalImages(item.preview) };
}

function stripExternalImages(value: string) {
    return value.replace(/!\[[^\]]*]\([^)]+\)/gi, "").trim();
}

function hashJson(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summarize(results: PromptSourceRefreshResult[]): PromptSourceRefreshSummary {
    return {
        results,
        total: results.reduce((sum, result) => sum + result.count, 0),
        successCount: results.filter((result) => result.success).length,
        failureCount: results.filter((result) => !result.success).length,
    };
}
