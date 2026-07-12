import { readSessionUser } from "@/lib/server/auth";
import { runResourceCleanup } from "@/lib/server/resource-db";

export async function POST() {
    const user = await readSessionUser();
    if (user?.role !== "admin") return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
    return Response.json({ code: 0, data: await runResourceCleanup(true), msg: "清理完成" });
}
