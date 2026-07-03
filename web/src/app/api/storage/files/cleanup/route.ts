import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { cleanupUserFiles } from "@/lib/server/user-data-db";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { usedKeys?: string[]; prefixes?: string[] } | null;
    await cleanupUserFiles(user.id, body?.usedKeys || [], body?.prefixes || []);
    return Response.json({ code: 0, msg: "清理成功" });
}
