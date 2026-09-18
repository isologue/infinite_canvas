import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_REMOTE_MEDIA_BYTES = 500 * 1024 * 1024;
export const REMOTE_MEDIA_TIMEOUT_MS = 600_000;

const MAX_REDIRECTS = 5;

export type RemoteMediaKind = "image" | "video" | "audio";

export function parseRemoteMediaUrl(value: unknown) {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
        return url;
    } catch {
        return null;
    }
}

export async function downloadRemoteMedia(initialUrl: URL, kind: RemoteMediaKind) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_MEDIA_TIMEOUT_MS);
    const label = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
    try {
        let url = initialUrl;
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
            await assertPublicUrl(url);
            const response = await fetch(url, { signal: controller.signal, redirect: "manual", cache: "no-store", headers: { accept: `${kind}/*` } });
            const location = response.headers.get("location");
            if ([301, 302, 303, 307, 308].includes(response.status) && location) {
                await response.body?.cancel().catch(() => undefined);
                if (redirects === MAX_REDIRECTS) throw new RemoteMediaDownloadError(`${label}下载重定向次数过多`, 502);
                const nextUrl = parseRemoteMediaUrl(new URL(location, url).toString());
                if (!nextUrl) throw new RemoteMediaDownloadError(`${label}下载重定向地址无效`, 502);
                url = nextUrl;
                continue;
            }
            if (!response.ok) throw new RemoteMediaDownloadError(`上游${label}下载失败（HTTP ${response.status}）`, 502);
            const contentLength = Number(response.headers.get("content-length") || 0);
            if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_MEDIA_BYTES) {
                await response.body?.cancel().catch(() => undefined);
                throw new RemoteMediaDownloadError(`上游${label}超过 500MB 限制`, 413);
            }
            return {
                content: await readRemoteContent(response, label),
                contentType: response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "",
                finalUrl: url,
            };
        }
        throw new RemoteMediaDownloadError(`${label}下载重定向次数过多`, 502);
    } catch (error) {
        if (error instanceof RemoteMediaDownloadError) throw error;
        if (error instanceof DOMException && error.name === "AbortError") throw new RemoteMediaDownloadError(`上游${label}下载超过 600 秒`, 504);
        throw new RemoteMediaDownloadError(error instanceof Error ? error.message : `上游${label}下载失败`, 502);
    } finally {
        clearTimeout(timeout);
    }
}

async function readRemoteContent(response: Response, label: string) {
    const reader = response.body?.getReader();
    if (!reader) throw new RemoteMediaDownloadError(`上游${label}没有可读取内容`, 502);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_REMOTE_MEDIA_BYTES) throw new RemoteMediaDownloadError(`上游${label}超过 500MB 限制`, 413);
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    if (!bytes) throw new RemoteMediaDownloadError(`上游${label}内容为空`, 502);
    return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        bytes,
    );
}

async function assertPublicUrl(url: URL) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
        throw new RemoteMediaDownloadError("不允许访问本地或内网媒体地址", 403);
    }
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new RemoteMediaDownloadError("不允许访问本地或内网媒体地址", 403);
}

function isPrivateAddress(address: string) {
    const normalized = address.toLowerCase();
    if (isIP(normalized) === 4) {
        const [a, b] = normalized.split(".").map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    if (isIP(normalized) === 6) {
        const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
        if (mapped) return isPrivateAddress(mapped);
        return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
    }
    return true;
}

export class RemoteMediaDownloadError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
