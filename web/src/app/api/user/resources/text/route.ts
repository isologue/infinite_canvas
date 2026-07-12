import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { registerTextResource } from "@/lib/server/resource-db";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { title?: string; content?: string; source?: string; metadata?: unknown } | null;
    const content = body?.content || "";
    if (!content.trim()) return Response.json({ code: 400, msg: "文本内容不能为空" }, { status: 400 });
    const resourceId = await registerTextResource(user.id, { title: body?.title, content, source: body?.source || "generated", metadata: body?.metadata });
    return Response.json({ code: 0, data: { resourceId }, msg: "保存成功" });
}
