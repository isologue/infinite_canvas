import { readStorageShareToken } from "@/lib/server/storage-share";
import { readUserFile, readUserFileInfo, readUserFileRange } from "@/lib/server/user-data-db";

const MAX_RANGE_BYTES = 4 * 1024 * 1024;

export async function GET(request: Request) {
    return serveFile(request, false);
}

export async function HEAD(request: Request) {
    return serveFile(request, true);
}

async function serveFile(request: Request, head: boolean) {
    const token = readStorageShareToken(new URL(request.url).searchParams.get("token"));
    if (!token) return new Response("Not Found", { status: 404 });
    const info = await readUserFileInfo(token.userId, token.storageKey);
    if (!info) return new Response("Not Found", { status: 404 });

    const total = Number(info.bytes);
    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
        const range = parseRange(rangeHeader, total);
        if (!range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}`, "accept-ranges": "bytes" } });
        const length = range.end - range.start + 1;
        const headers = {
            "content-type": info.mime_type,
            "content-length": String(length),
            "content-range": `bytes ${range.start}-${range.end}/${total}`,
            "cache-control": "public, max-age=300",
            "accept-ranges": "bytes",
        };
        if (head) return new Response(null, { status: 206, headers });
        const content = await readUserFileRange(token.userId, token.storageKey, range.start, length);
        if (!content) return new Response("Not Found", { status: 404 });
        return new Response(new Uint8Array(content), { status: 206, headers });
    }

    const headers = {
        "content-type": info.mime_type,
        "content-length": String(info.bytes),
        "cache-control": "public, max-age=300",
        "accept-ranges": "bytes",
    };
    if (head) return new Response(null, { headers });
    const file = await readUserFile(token.userId, token.storageKey);
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(new Uint8Array(file.content), { headers });
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
