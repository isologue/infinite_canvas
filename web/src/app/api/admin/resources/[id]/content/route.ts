import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { getUserImagePreview } from "@/lib/server/image-preview";
import { readAdminResource } from "@/lib/server/resource-db";
import { readUserFile, readUserFileInfo, readUserFileRange } from "@/lib/server/user-data-db";

const MAX_RANGE_BYTES = 4 * 1024 * 1024;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return new Response("Forbidden", { status: 403 });
    const { id } = await context.params;
    const userId = request.nextUrl.searchParams.get("userId") || "";
    const resource = await readAdminResource(userId, decodeURIComponent(id));
    if (!resource) return new Response("Not Found", { status: 404 });
    const download = request.nextUrl.searchParams.get("download") === "1";
    if (resource.kind === "text") return new Response(resource.textContent, { headers: contentHeaders("text/plain; charset=utf-8", Buffer.byteLength(resource.textContent), download, `${resource.title || "resource"}.txt`) });
    if (!resource.storageKey) return new Response("Not Found", { status: 404 });
    if (!download && resource.kind === "image" && request.nextUrl.searchParams.get("preview") === "1") {
        const preview = await getUserImagePreview(userId, resource.storageKey);
        if (!preview) return new Response("Not Found", { status: 404 });
        return new Response(new Uint8Array(preview.content), { headers: contentHeaders(preview.mimeType, preview.content.length, false, resource.title) });
    }
    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
        const info = await readUserFileInfo(userId, resource.storageKey);
        if (!info) return new Response("Not Found", { status: 404 });
        const total = Number(info.bytes);
        const range = parseRange(rangeHeader, total);
        if (!range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}`, "accept-ranges": "bytes" } });
        const content = await readUserFileRange(userId, resource.storageKey, range.start, range.end - range.start + 1);
        if (!content) return new Response("Not Found", { status: 404 });
        return new Response(new Uint8Array(content), { status: 206, headers: { ...contentHeaders(info.mime_type, content.length, download, downloadName(resource.title, info.mime_type)), "content-range": `bytes ${range.start}-${range.end}/${total}`, "accept-ranges": "bytes" } });
    }
    const file = await readUserFile(userId, resource.storageKey);
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(new Uint8Array(file.content), { headers: { ...contentHeaders(file.mime_type, Number(file.bytes), download, downloadName(resource.title, file.mime_type)), "accept-ranges": "bytes" } });
}

function contentHeaders(mimeType: string, bytes: number, download: boolean, title: string) {
    return { "content-type": mimeType, "content-length": String(bytes), "cache-control": "private, no-store", ...(download ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(title || "resource")}` } : {}) };
}

function downloadName(title: string, mimeType: string) {
    const name = title || "resource";
    if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
    const extension = mimeType.includes("png") ? "png" : mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : mimeType.includes("gif") ? "gif" : mimeType.includes("webm") ? "webm" : mimeType.includes("wav") ? "wav" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : mimeType.startsWith("audio/mp4") ? "m4a" : mimeType.startsWith("video/") ? "mp4" : "bin";
    return `${name}.${extension}`;
}

function parseRange(header: string, total: number) {
    const match = header.trim().toLowerCase().match(/^bytes=(\d*)-(\d*)$/);
    if (!match || !Number.isSafeInteger(total) || total <= 0) return null;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
        return { start: Math.max(0, total - suffix), end: total - 1 };
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : Math.min(total - 1, start + MAX_RANGE_BYTES - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return null;
    return { start, end: Math.min(end, total - 1) };
}
