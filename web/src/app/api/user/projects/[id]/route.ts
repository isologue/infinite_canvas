import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { normalizeCanvasProject } from "@/lib/server/canvas-project";
import { hasUserProject, readUserProject, renameUserProject, upsertUserProject } from "@/lib/server/user-data-db";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const project = await readUserProject(user.id, (await context.params).id);
    if (!project) return Response.json({ code: 404, msg: "画布不存在" }, { status: 404 });
    return Response.json({ code: 0, data: { project }, msg: "读取成功" });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const id = (await context.params).id;
    if (!(await hasUserProject(user.id, id))) return Response.json({ code: 404, msg: "画布不存在" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { project?: unknown } | null;
    const project = normalizeCanvasProject(body?.project);
    if (!project || project.id !== id) return Response.json({ code: 400, msg: "画布数据不完整" }, { status: 400 });
    return Response.json({ code: 0, data: { project: await upsertUserProject(user.id, project) }, msg: "保存成功" });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) return Response.json({ code: 400, msg: "画布名称不能为空" }, { status: 400 });
    const project = await renameUserProject(user.id, (await context.params).id, title);
    if (!project) return Response.json({ code: 404, msg: "画布不存在" }, { status: 404 });
    return Response.json({ code: 0, data: { project }, msg: "重命名成功" });
}
