import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readSharedConfig, writeSharedConfig } from "@/lib/server/shared-config-db";

export async function GET() {
    try {
        const user = await readSessionUser();
        const shared = await readSharedConfig();
        return Response.json({
            code: 0,
            data: {
                config: shared.config,
                webdav: shared.webdav,
                canManage: user?.role === "admin",
            },
        });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "读取共享配置失败" }, { status: 500 });
    }
}

export async function PUT(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return Response.json({ code: 403, msg: "只有 admin 可以修改共享配置" }, { status: 403 });
    try {
        const body = (await request.json()) as { config?: Record<string, unknown>; webdav?: Record<string, unknown> };
        if (!body?.config || !body?.webdav) return Response.json({ code: 400, msg: "配置数据不完整" }, { status: 400 });
        const saved = await writeSharedConfig({ config: body.config, webdav: body.webdav });
        return Response.json({ code: 0, msg: "共享配置已保存", data: saved });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "保存共享配置失败" }, { status: 500 });
    }
}
