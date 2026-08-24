import { after, NextRequest } from "next/server";

import { resolveImageMimeType } from "@/lib/image-mime";
import { readSessionUser } from "@/lib/server/auth";
import { getUserImagePreview } from "@/lib/server/image-preview";
import { saveUserFileResource } from "@/lib/server/resource-db";

const MAX_REFERENCE_IMAGE_BYTES = 15 * 1024 * 1024;
const REFERENCE_UPLOAD_SOURCES = new Set(["reference-upload", "canvas-upload", "asset-upload"]);

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const storageKey = request.headers.get("x-storage-key") || "";
    const declaredMimeType = request.headers.get("x-storage-mime-type") || "application/octet-stream";
    const title = decodeHeader(request.headers.get("x-resource-title"));
    const source = request.headers.get("x-resource-source") || "upload";
    const metadata = decodeMetadataHeader(request.headers.get("x-resource-metadata"));
    if (!storageKey) return Response.json({ code: 400, msg: "缺少 storageKey" }, { status: 400 });
    const content = Buffer.from(await request.arrayBuffer());
    const mimeType = resolveImageMimeType(content, declaredMimeType);
    if (mimeType.startsWith("image/") && REFERENCE_UPLOAD_SOURCES.has(source) && content.length > MAX_REFERENCE_IMAGE_BYTES) {
        return Response.json({ code: 413, msg: "参考图超过单张 15MB 限制" }, { status: 413 });
    }
    await saveUserFileResource(user.id, { storageKey, mimeType, bytes: content.length, content, title, source, metadata: { ...metadata, mimeType } });
    if (mimeType.startsWith("image/")) after(() => getUserImagePreview(user.id, storageKey).then(() => undefined).catch(() => undefined));
    return Response.json({ code: 0, msg: "保存成功" });
}

export async function DELETE() {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    return Response.json({ code: 403, msg: "资源只能由管理员在资源管理中删除" }, { status: 403 });
}

function decodeHeader(value: string | null) {
    if (!value) return "";
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function decodeMetadataHeader(value: string | null) {
    const decoded = decodeHeader(value);
    if (!decoded) return {};
    try {
        const parsed = JSON.parse(decoded);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}
