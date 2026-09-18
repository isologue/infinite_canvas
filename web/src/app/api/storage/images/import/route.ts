import { randomUUID } from "node:crypto";

import { after, NextRequest } from "next/server";
import sharp from "sharp";

import { readSessionUser } from "@/lib/server/auth";
import { getUserImagePreview } from "@/lib/server/image-preview";
import { downloadRemoteMedia, parseRemoteMediaUrl, RemoteMediaDownloadError } from "@/lib/server/remote-media-download";
import { saveUserFileResource } from "@/lib/server/resource-db";

const MAX_IMAGE_PIXELS = 100_000_000;

type ImageImportPayload = { url?: unknown; title?: unknown; source?: unknown; metadata?: unknown };

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });

    try {
        const body = (await request.json()) as ImageImportPayload;
        const url = parseRemoteMediaUrl(body.url);
        if (!url) return Response.json({ code: 400, msg: "图片 URL 格式错误" }, { status: 400 });
        const { content, finalUrl } = await downloadRemoteMedia(url, "image");
        const { mimeType, width, height } = await inspectImage(content);
        const storageKey = `image:${randomUUID()}`;
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
        const source = typeof body.source === "string" ? body.source.trim().slice(0, 64) || "generated" : "generated";
        const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {};
        await saveUserFileResource(user.id, {
            storageKey,
            mimeType,
            bytes: content.length,
            content,
            title,
            source,
            metadata: { ...metadata, width, height, mimeType, bytes: content.length, transfer: "server", originUrl: finalUrl.toString() },
        });
        after(() =>
            getUserImagePreview(user.id, storageKey)
                .then(() => undefined)
                .catch(() => undefined),
        );
        return Response.json({ code: 0, data: { storageKey, bytes: content.length, mimeType, width, height } });
    } catch (error) {
        const status = error instanceof RemoteMediaDownloadError ? error.status : error instanceof ImageInspectError ? error.status : 502;
        return Response.json({ code: status, msg: error instanceof Error ? error.message : "图片服务端转存失败" }, { status });
    }
}

async function inspectImage(content: Buffer) {
    try {
        const image = await sharp(content).metadata();
        const mimeType = imageMimeType(image.format);
        const rotated = image.orientation !== undefined && image.orientation >= 5 && image.orientation <= 8;
        const width = rotated ? image.height : image.width;
        const height = rotated ? image.width : image.height;
        if (!mimeType || !width || !height) throw new Error("unsupported image");
        if (width * height > MAX_IMAGE_PIXELS) throw new ImageInspectError("上游图片像素尺寸过大", 413);
        return { content, mimeType, width, height };
    } catch (error) {
        if (error instanceof ImageInspectError) throw error;
        throw new ImageInspectError("上游响应不是支持的图片文件", 422);
    }
}

function imageMimeType(format?: string) {
    if (format === "jpeg") return "image/jpeg";
    if (format === "png") return "image/png";
    if (format === "webp") return "image/webp";
    if (format === "gif") return "image/gif";
    if (format === "avif") return "image/avif";
    return "";
}

class ImageInspectError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
