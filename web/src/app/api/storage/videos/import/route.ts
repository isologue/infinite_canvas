import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { downloadRemoteMedia, parseRemoteMediaUrl, RemoteMediaDownloadError } from "@/lib/server/remote-media-download";
import { saveUserFileResource } from "@/lib/server/resource-db";
import { readSharedConfig } from "@/lib/server/shared-config-db";
import { uploadSavedUserFileToWebdav } from "@/lib/server/webdav-image-storage";

type VideoImportPayload = { url?: unknown; title?: unknown; source?: unknown };

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });

    try {
        const body = (await request.json()) as VideoImportPayload;
        const url = parseRemoteMediaUrl(body.url);
        if (!url) return Response.json({ code: 400, msg: "视频 URL 格式错误" }, { status: 400 });
        const { content, contentType, finalUrl } = await downloadRemoteMedia(url, "video");
        const mimeType = resolveVideoMimeType(contentType, finalUrl);
        if (!mimeType) throw new MediaTypeError("上游响应不是支持的视频文件", 422);
        const storageKey = `video:${randomUUID()}`;
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
        const publicUrl = await uploadSavedUserFileToWebdav((await readSharedConfig()).webdav, user.id, { storageKey, mimeType, content, source });
        return Response.json({ code: 0, data: { storageKey, bytes: content.length, mimeType, ...(publicUrl ? { url: publicUrl } : {}) } });
    } catch (error) {
        const status = error instanceof RemoteMediaDownloadError ? error.status : error instanceof MediaTypeError ? error.status : 502;
        return Response.json({ code: status, msg: error instanceof Error ? error.message : "视频服务端转存失败" }, { status });
    }
}

function resolveVideoMimeType(contentType: string, url: URL) {
    if (contentType.startsWith("video/")) return contentType;
    const extension = url.pathname.split(".").pop()?.toLowerCase();
    if (extension === "mp4" || extension === "m4v") return "video/mp4";
    if (extension === "webm") return "video/webm";
    if (extension === "mov") return "video/quicktime";
    if (extension === "avi") return "video/x-msvideo";
    if (extension === "mpeg" || extension === "mpg") return "video/mpeg";
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
