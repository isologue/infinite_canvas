import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { normalizeCanvasProject } from "@/lib/server/canvas-project";
import { deleteUserProjects, listUserProjects, upsertUserProject } from "@/lib/server/user-data-db";

export async function GET() {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    return Response.json({ code: 0, data: { projects: await listUserProjects(user.id) }, msg: "读取成功" });
}

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { project?: unknown } | null;
    const project = normalizeCanvasProject(body?.project);
    if (!project) return Response.json({ code: 400, msg: "画布数据不完整" }, { status: 400 });
    return Response.json({ code: 0, data: { project: await upsertUserProject(user.id, project) }, msg: "创建成功" });
}

export async function DELETE(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string" && Boolean(id.trim())) : [];
    if (!ids.length) return Response.json({ code: 400, msg: "请选择画布" }, { status: 400 });
    await deleteUserProjects(user.id, ids);
    return Response.json({ code: 0, msg: "删除成功" });
}
