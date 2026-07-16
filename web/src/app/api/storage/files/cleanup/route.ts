import { readSessionUser } from "@/lib/server/auth";

export async function POST() {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    return Response.json({ code: 403, msg: "资源只能由管理员在资源管理中删除" }, { status: 403 });
}
