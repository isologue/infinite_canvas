import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { saveUserFileResource } from "@/lib/server/resource-db";
import { readVideoDownloadSettings } from "@/lib/server/video-download-settings-db";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

type VideoImportPayload = { url?: unknown; title?: unknown };

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "Please sign in" }, { status: 401 });

    try {
        const settings = await readVideoDownloadSettings();
        if (!settings.enabled) return unavailable("disabled");
        const body = await request.json() as VideoImportPayload;
        const url = parseVideoUrl(body.url, settings.allowedHosts);
        if (!url) return unavailable("host_not_allowed");
        const { mimeType, content } = await downloadVideo(url);
        const storageKey = `video:${randomUUID()}`;
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
        await saveUserFileResource(user.id, { storageKey, mimeType, bytes: content.length, content, title, source: "generated", metadata: { transfer: "server", originUrl: url.toString() } });
        return Response.json({ code: 0, data: { storageKey, bytes: content.length, mimeType } });
    } catch (error) {
        const status = error instanceof VideoDownloadError ? error.status : 502;
        return Response.json({
            code: status,
            msg: error instanceof Error ? error.message : "Video server transfer failed",
            ...(error instanceof VideoDownloadError && error.data !== undefined ? { data: error.data } : {}),
        }, { status });
    }
}

function unavailable(reason: "disabled" | "host_not_allowed") {
    return Response.json({ code: 409, msg: "Video server transfer is unavailable", data: { reason } }, { status: 409 });
}

function isAllowedVideoHost(hostname: string, allowedHosts: string[]) {
    const host = hostname.toLowerCase();
    return allowedHosts.some((allowedHost) => {
        if (!allowedHost.startsWith("*.")) return host === allowedHost;
        const suffix = allowedHost.slice(1);
        return host.endsWith(suffix) && host.length > suffix.length;
    });
}

function parseVideoUrl(value: unknown, allowedHosts: string[]) {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !isAllowedVideoHost(url.hostname, allowedHosts)) return null;
        return url;
    } catch {
        return null;
    }
}

async function downloadVideo(url: URL) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal, redirect: "manual", cache: "no-store", headers: { accept: "video/*" } });
        if (response.status >= 300 && response.status < 400) throw new VideoDownloadError("The upstream video URL redirected and was rejected", 502, { upstreamStatus: response.status, upstreamStatusText: response.statusText || undefined });
        if (!response.ok) throw new VideoDownloadError(`Upstream video download failed (${response.status})`, 502, await upstreamResponseResult(response));
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
        if (!mimeType.startsWith("video/")) throw new VideoDownloadError("The upstream response is not a video file", 422, await upstreamResponseResult(response));
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES) throw new VideoDownloadError("The upstream video exceeds the 200MB limit", 413, { upstreamStatus: response.status, upstreamStatusText: response.statusText || undefined, contentLength });
        return { mimeType, content: await readVideoContent(response) };
    } catch (error) {
        if (error instanceof VideoDownloadError) throw error;
        if (error instanceof DOMException && error.name === "AbortError") throw new VideoDownloadError("Upstream video download timed out", 504);
        throw new VideoDownloadError(error instanceof Error ? error.message : "Upstream video download failed", 502);
    } finally {
        clearTimeout(timeout);
    }
}

async function upstreamResponseResult(response: Response) {
    const result: { upstreamStatus: number; upstreamStatusText?: string; contentType?: string; data?: unknown } = {
        upstreamStatus: response.status,
        ...(response.statusText ? { upstreamStatusText: response.statusText } : {}),
        ...(response.headers.get("content-type") ? { contentType: response.headers.get("content-type") || undefined } : {}),
    };
    const text = await readResponsePreview(response);
    if (!text) return result;
    try {
        return { ...result, data: JSON.parse(text) };
    } catch {
        return { ...result, data: text };
    }
}

async function readResponsePreview(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (bytes < 64 * 1024) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value.slice(0, 64 * 1024 - bytes);
            chunks.push(chunk);
            bytes += chunk.byteLength;
            if (chunk.byteLength < value.byteLength) break;
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8").trim();
}

async function readVideoContent(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) throw new VideoDownloadError("The upstream video has no readable content", 502);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_VIDEO_BYTES) throw new VideoDownloadError("The upstream video exceeds the 200MB limit", 413);
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    if (!bytes) throw new VideoDownloadError("The upstream video is empty", 502);
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
}

class VideoDownloadError extends Error {
    constructor(message: string, readonly status: number, readonly data?: unknown) {
        super(message);
    }
}
