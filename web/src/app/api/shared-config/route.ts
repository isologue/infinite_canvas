import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { lockedChannelBaseUrl, readSharedConfig, readUserConfig, writeSharedConfig, writeUserConfig } from "@/lib/server/shared-config-db";

export async function GET() {
    try {
        const user = await readSessionUser();
        const isAdmin = user?.role === "admin";
        // 超管读写全局配置（渠道 URL/key 的权威来源）；普通用户读自己那份（渠道 URL/key 由服务端用全局回填）。
        const shared = user && !isAdmin ? await readUserConfig(user.id) : await readSharedConfig();
        return Response.json({
            code: 0,
            data: {
                config: shared.config,
                webdav: shared.webdav,
                // 所有登录用户都能保存自己的配置；只有超管能改渠道 URL。
                canManage: Boolean(user),
                canManageUrl: isAdmin,
                // 普通用户新建渠道时锁定的 baseUrl（超管不受此限）。
                lockedBaseUrl: lockedChannelBaseUrl(),
            },
        });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "读取配置失败" }, { status: 500 });
    }
}

export async function PUT(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    try {
        const body = (await request.json()) as { config?: Record<string, unknown>; webdav?: Record<string, unknown> };
        if (!body?.config) return Response.json({ code: 400, msg: "配置数据不完整" }, { status: 400 });
        if (user.role === "admin") {
            if (!body?.webdav) return Response.json({ code: 400, msg: "配置数据不完整" }, { status: 400 });
            const saved = await writeSharedConfig({ config: body.config, webdav: body.webdav });
            return Response.json({ code: 0, msg: "配置已保存", data: saved });
        }
        // 普通用户：存自己那份（config + webdav），服务端只强制锁定渠道 URL，其余全是用户自己的。
        const saved = await writeUserConfig(user.id, body.config, body.webdav);
        return Response.json({ code: 0, msg: "配置已保存", data: saved });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "保存配置失败" }, { status: 500 });
    }
}
