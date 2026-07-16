import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { markDeletedAssetResources, syncUserSavedResources } from "@/lib/server/resource-db";
import { readUserAssets, writeUserAssets } from "@/lib/server/user-data-db";

export async function GET() {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const assets = await readUserAssets(user.id);
    return Response.json({ code: 0, data: { assets: await markDeletedAssetResources(user.id, assets) } });
}

export async function PUT(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { assets?: unknown } | null;
    const assets = body?.assets || [];
    await writeUserAssets(user.id, assets);
    await syncUserSavedResources(user.id, assets);
    return Response.json({ code: 0, msg: "保存成功" });
}
