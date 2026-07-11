import { after, NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { getUserImagePreview } from "@/lib/server/image-preview";
import { deleteUserFiles, upsertUserFile } from "@/lib/server/user-data-db";

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const storageKey = request.headers.get("x-storage-key") || "";
    const mimeType = request.headers.get("x-storage-mime-type") || "application/octet-stream";
    if (!storageKey) return Response.json({ code: 400, msg: "缺少 storageKey" }, { status: 400 });
    const content = Buffer.from(await request.arrayBuffer());
    await upsertUserFile(user.id, { storageKey, mimeType, bytes: content.length, content });
    if (mimeType.startsWith("image/")) after(() => getUserImagePreview(user.id, storageKey).then(() => undefined).catch(() => undefined));
    return Response.json({ code: 0, msg: "保存成功" });
}

export async function DELETE(request: NextRequest) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { keys?: string[] } | null;
    await deleteUserFiles(user.id, body?.keys || []);
    return Response.json({ code: 0, msg: "删除成功" });
}
