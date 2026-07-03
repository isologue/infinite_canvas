import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readUserProjects, writeUserProjects } from "@/lib/server/user-data-db";

export async function GET() {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const projects = await readUserProjects(user.id);
    return Response.json({ code: 0, data: { projects } });
}

export async function PUT(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { projects?: unknown } | null;
    await writeUserProjects(user.id, body?.projects || []);
    return Response.json({ code: 0, msg: "保存成功" });
}
