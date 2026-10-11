import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readSharedConfig } from "@/lib/server/shared-config-db";
import { readUserFile } from "@/lib/server/user-data-db";
import { uploadUserFileToWebdav } from "@/lib/server/webdav-image-storage";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    try {
        const body = await request.json() as { storageKey?: unknown };
        const storageKey = typeof body.storageKey === "string" ? body.storageKey : "";
        if (!storageKey) return Response.json({ code: 400, msg: "缺少 storageKey" }, { status: 400 });
        const file = await readUserFile(user.id, storageKey);
        if (!file) return Response.json({ code: 404, msg: "参考素材不存在" }, { status: 404 });
        if (!/^(image|video|audio)\//.test(file.mime_type)) return Response.json({ code: 422, msg: "该资源不是图片、视频或音频" }, { status: 422 });
        const url = await uploadUserFileToWebdav((await readSharedConfig()).webdav, user.id, { storageKey, mimeType: file.mime_type, content: file.content });
        if (!url) return Response.json({ code: 409, msg: "管理员尚未启用 WebDAV 媒体存储" }, { status: 409 });
        return Response.json({ code: 0, data: { url } });
    } catch (error) {
        return Response.json({ code: 502, msg: error instanceof Error ? error.message : "WebDAV 媒体上传失败" }, { status: 502 });
    }
}
