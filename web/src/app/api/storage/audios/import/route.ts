import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { downloadRemoteMedia, parseRemoteMediaUrl, RemoteMediaDownloadError } from "@/lib/server/remote-media-download";
import { saveUserFileResource } from "@/lib/server/resource-db";

type AudioImportPayload = { url?: unknown; title?: unknown; source?: unknown };

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });

    try {
        const body = (await request.json()) as AudioImportPayload;
        const url = parseRemoteMediaUrl(body.url);
        if (!url) return Response.json({ code: 400, msg: "音频 URL 格式错误" }, { status: 400 });
        const { content, contentType, finalUrl } = await downloadRemoteMedia(url, "audio");
        const mimeType = resolveAudioMimeType(contentType, finalUrl);
        if (!mimeType) throw new MediaTypeError("上游响应不是支持的音频文件", 422);
        const storageKey = `audio:${randomUUID()}`;
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
        const source = typeof body.source === "string" ? body.source.trim().slice(0, 64) || "generated" : "generated";
        await saveUserFileResource(user.id, {
            storageKey,
            mimeType,
            bytes: content.length,
            content,
            title,
            source,
            metadata: { transfer: "server", originUrl: finalUrl.toString(), mimeType, bytes: content.length },
        });
        return Response.json({ code: 0, data: { storageKey, bytes: content.length, mimeType } });
    } catch (error) {
        const status = error instanceof RemoteMediaDownloadError ? error.status : error instanceof MediaTypeError ? error.status : 502;
        return Response.json({ code: status, msg: error instanceof Error ? error.message : "音频服务端转存失败" }, { status });
    }
}

function resolveAudioMimeType(contentType: string, url: URL) {
    if (contentType.startsWith("audio/")) return contentType;
    const extension = url.pathname.split(".").pop()?.toLowerCase();
    if (extension === "mp3") return "audio/mpeg";
    if (extension === "wav") return "audio/wav";
    if (extension === "ogg" || extension === "opus") return "audio/ogg";
    if (extension === "m4a") return "audio/mp4";
    if (extension === "aac") return "audio/aac";
    if (extension === "flac") return "audio/flac";
    return "";
}

class MediaTypeError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
