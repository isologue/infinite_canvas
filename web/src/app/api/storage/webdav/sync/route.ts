import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readSharedConfig } from "@/lib/server/shared-config-db";
import { listAllUserImageFiles } from "@/lib/server/user-data-db";
import { uploadUserImageToWebdav } from "@/lib/server/webdav-image-storage";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ code: 403, msg: "仅超级管理员可管理 WebDAV" }, { status: 403 });
    try {
        const current = (await readSharedConfig()).webdav;
        const patch = await request.json().catch(() => ({})) as Record<string, unknown>;
        const config: { enabled?: boolean; storageMode?: string; password?: string; [key: string]: unknown } = { ...current, ...patch, password: typeof patch.password === "string" && patch.password ? patch.password : typeof current.password === "string" ? current.password : "" };
        if (config.enabled !== true || config.storageMode === "local") return Response.json({ code: 400, msg: "请先启用 WebDAV 图片存储" }, { status: 400 });
        const files = await listAllUserImageFiles();
        for (const file of files) await uploadUserImageToWebdav(config, file.user_id, { storageKey: file.storage_key, mimeType: file.mime_type, content: file.content });
        return Response.json({ code: 0, msg: `已同步 ${files.length} 张图片`, data: { count: files.length } });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "WebDAV 全量同步失败" }, { status: 500 });
    }
}
