import { NextRequest } from "next/server";

import { readPromptCoverCache, writePromptCoverCache } from "@/lib/server/prompt-cover-cache-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const blockedHosts = new Set(["localhost", "127.0.0.1", "::1"]);

export async function GET(request: NextRequest) {
    const target = request.nextUrl.searchParams.get("url") || "";
    if (!target) return new Response("Missing url", { status: 400 });

    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return new Response("Invalid url", { status: 400 });
    }

    if (!/^https?:$/i.test(url.protocol)) return new Response("Unsupported protocol", { status: 400 });
    if (blockedHosts.has(url.hostname) || isPrivateHostname(url.hostname)) return new Response("Blocked host", { status: 400 });

    const cached = await readPromptCoverCache(url.toString()).catch(() => null);
    if (cached && !cached.stale) return imageResponse(cached.content, cached.mimeType, cached.bytes, true);

    try {
        const upstream = await fetch(url, {
            cache: "no-store",
            headers: {
                "user-agent": "infinite-canvas-prompt-cover/1.0",
                accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
        });
        if (!upstream.ok) {
            if (cached) return imageResponse(cached.content, cached.mimeType, cached.bytes, true);
            return new Response("Upstream failed", { status: upstream.status });
        }
        const contentType = upstream.headers.get("content-type") || "image/jpeg";
        const arrayBuffer = await upstream.arrayBuffer();
        const content = Buffer.from(arrayBuffer);
        await writePromptCoverCache(url.toString(), { mimeType: contentType, bytes: content.length, content }).catch(() => null);
        return imageResponse(content, contentType, content.length, false);
    } catch {
        if (cached) return imageResponse(cached.content, cached.mimeType, cached.bytes, true);
        return new Response("Fetch failed", { status: 502 });
    }
}

function imageResponse(content: Buffer, contentType: string, bytes: number, cached: boolean) {
    return new Response(new Uint8Array(content), {
        headers: {
            "content-type": contentType,
            "content-length": String(bytes),
            "cache-control": cached ? "public, max-age=86400, stale-while-revalidate=604800" : "public, max-age=3600, stale-while-revalidate=86400",
            "x-prompt-cover-cache": cached ? "hit" : "miss",
        },
    });
}

function isPrivateHostname(hostname: string) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        const [a, b] = hostname.split(".").map(Number);
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
    }
    return false;
}
