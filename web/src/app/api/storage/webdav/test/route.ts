import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readSharedConfig } from "@/lib/server/shared-config-db";
import { testWebdavImageStorage } from "@/lib/server/webdav-image-storage";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ code: 403, msg: "仅超级管理员可管理 WebDAV" }, { status: 403 });
    try {
        const current = await readSharedConfig();
        const patch = await request.json().catch(() => ({})) as Record<string, unknown>;
        const config = { ...current.webdav, ...patch, password: typeof patch.password === "string" && patch.password ? patch.password : current.webdav.password };
        await testWebdavImageStorage(config);
        return Response.json({ code: 0, msg: "WebDAV 连接可用" });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "WebDAV 连接测试失败" }, { status: 500 });
    }
}
