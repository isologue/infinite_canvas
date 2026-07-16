import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { lockedChannelBaseUrls } from "@/lib/server/shared-config-db";

const blockedRequestHeaders = new Set(["accept-encoding", "connection", "content-length", "cookie", "host", "origin", "priority", "referer", "transfer-encoding"]);
const blockedResponseHeaders = new Set(["connection", "content-encoding", "content-length", "set-cookie", "set-cookie2", "transfer-encoding"]);

async function proxyAiRequest(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "\u8bf7\u5148\u767b\u5f55" }, { status: 401 });

    const rawUrl = request.nextUrl.searchParams.get("url")?.trim();
    if (!rawUrl) return Response.json({ code: 400, msg: "\u7f3a\u5c11\u4e0a\u6e38 URL" }, { status: 400 });

    let target: URL;
    try {
        target = new URL(rawUrl);
    } catch {
        return Response.json({ code: 400, msg: "\u4e0a\u6e38 URL \u683c\u5f0f\u9519\u8bef" }, { status: 400 });
    }
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) {
        return Response.json({ code: 400, msg: "\u53ea\u652f\u6301 HTTP/HTTPS \u4e0a\u6e38\u5730\u5740" }, { status: 400 });
    }
    if (user.role !== "admin" && !lockedChannelBaseUrls().some((baseUrl) => isUrlUnderBase(target, baseUrl))) {
        return Response.json({ code: 403, msg: "\u5f53\u524d\u7528\u6237\u65e0\u6743\u8bf7\u6c42\u8be5 Base URL" }, { status: 403 });
    }

    const headers = new Headers();
    request.headers.forEach((value, key) => {
        const normalizedKey = key.toLowerCase();
        if (!blockedRequestHeaders.has(normalizedKey) && !normalizedKey.startsWith("sec-") && !normalizedKey.startsWith("x-forwarded-")) headers.set(key, value);
    });
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

    try {
        let currentUrl = target;
        let method = request.method;
        let currentBody = body;
        let upstream: Response | undefined;
        for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
            upstream = await fetch(currentUrl, { method, headers, body: currentBody, cache: "no-store", redirect: "manual", signal: request.signal });
            const location = upstream.headers.get("location");
            if (![301, 302, 303, 307, 308].includes(upstream.status) || !location) break;
            currentUrl = new URL(location, currentUrl);
            if (!/^https?:$/.test(currentUrl.protocol) || currentUrl.username || currentUrl.password) {
                return Response.json({ code: 400, msg: "\u4e0a\u6e38\u91cd\u5b9a\u5411\u4e0d\u662f HTTP/HTTPS URL" }, { status: 400 });
            }
            if (user.role !== "admin" && !lockedChannelBaseUrls().some((baseUrl) => isUrlUnderBase(currentUrl, baseUrl))) {
                return Response.json({ code: 403, msg: "\u4e0a\u6e38\u91cd\u5b9a\u5411\u8d85\u51fa\u5141\u8bb8\u7684 Base URL" }, { status: 403 });
            }
            if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && method === "POST")) {
                method = "GET";
                currentBody = undefined;
                headers.delete("content-type");
            }
        }
        if (!upstream || ([301, 302, 303, 307, 308].includes(upstream.status) && upstream.headers.has("location"))) {
            return Response.json({ code: 502, msg: "\u4e0a\u6e38\u91cd\u5b9a\u5411\u6b21\u6570\u8fc7\u591a" }, { status: 502 });
        }
        const responseHeaders = new Headers();
        upstream.headers.forEach((value, key) => {
            if (!blockedResponseHeaders.has(key.toLowerCase())) responseHeaders.set(key, value);
        });
        return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    } catch (error) {
        return Response.json({ code: 502, msg: error instanceof Error ? error.message : "\u4e0a\u6e38\u8bf7\u6c42\u5931\u8d25" }, { status: 502 });
    }
}

function isUrlUnderBase(target: URL, rawBaseUrl: string) {
    try {
        const base = new URL(rawBaseUrl);
        if (target.origin !== base.origin) return false;
        const basePath = base.pathname.replace(/\/+$/, "");
        return !basePath || basePath === "/" || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
    } catch {
        return false;
    }
}

export const GET = proxyAiRequest;
export const POST = proxyAiRequest;
export const PUT = proxyAiRequest;
export const PATCH = proxyAiRequest;
export const DELETE = proxyAiRequest;
