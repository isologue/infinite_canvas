import { readSessionUser } from "@/lib/server/auth";
import { getUserImagePreview } from "@/lib/server/image-preview";
import { readUserFile, readUserFileInfo, readUserFileRange } from "@/lib/server/user-data-db";

const MAX_RANGE_BYTES = 4 * 1024 * 1024;

export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
    const user = await readSessionUser();
    if (!user) return new Response("Unauthorized", { status: 401 });
    const { key } = await context.params;
    const storageKey = decodeURIComponent(key);
    if (new URL(request.url).searchParams.get("preview") === "1") {
        const preview = await getUserImagePreview(user.id, storageKey);
        if (!preview) return new Response("Not Found", { status: 404 });
        return new Response(new Uint8Array(preview.content), {
            headers: {
                "content-type": preview.mimeType,
                "content-length": String(preview.content.length),
                "cache-control": "private, max-age=86400, stale-while-revalidate=604800",
                vary: "cookie",
            },
        });
    }
    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
        const info = await readUserFileInfo(user.id, storageKey);
        if (!info) return new Response("Not Found", { status: 404 });
        const total = Number(info.bytes);
        const range = parseRange(rangeHeader, total);
        if (!range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}`, "accept-ranges": "bytes" } });
        const content = await readUserFileRange(user.id, storageKey, range.start, range.end - range.start + 1);
        if (!content) return new Response("Not Found", { status: 404 });
        return new Response(new Uint8Array(content), {
            status: 206,
            headers: {
                "content-type": info.mime_type,
                "content-length": String(content.length),
                "content-range": `bytes ${range.start}-${range.end}/${total}`,
                "accept-ranges": "bytes",
                "cache-control": "private, max-age=3600",
                vary: "cookie",
            },
        });
    }
    const file = await readUserFile(user.id, storageKey);
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(new Uint8Array(file.content), {
        headers: {
            "content-type": file.mime_type,
            "content-length": file.bytes,
            "accept-ranges": "bytes",
            "cache-control": "private, max-age=3600",
            vary: "cookie",
        },
    });
}

function parseRange(header: string, total: number) {
    const normalized = header.trim().toLowerCase();
    if (!Number.isSafeInteger(total) || total <= 0 || !normalized.startsWith("bytes=") || normalized.includes(",")) return null;
    const [startValue, endValue] = normalized.slice(6).trim().split("-");
    if (startValue === "") {
        const suffix = Number(endValue);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
        return { start: Math.max(0, total - suffix), end: total - 1 };
    }
    const start = Number(startValue);
    const requestedEnd = endValue === "" ? Math.min(total - 1, start + MAX_RANGE_BYTES - 1) : Number(endValue);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= total || requestedEnd < start) return null;
    return { start, end: Math.min(requestedEnd, total - 1) };
}
