import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readUserFile } from "@/lib/server/user-data-db";

// admin 专用：按 userId + storageKey 读取任意用户的媒体文件，用于在调用日志里预览图片/视频/音频。
// 普通用户的 /api/storage/files/[key] 只能读自己的，跨用户预览必须走这个受 admin 保护的端点。
export async function GET(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return new Response("Forbidden", { status: 403 });

    const userId = request.nextUrl.searchParams.get("userId")?.trim() || "";
    const key = request.nextUrl.searchParams.get("key")?.trim() || "";
    if (!userId || !key) return new Response("Bad Request", { status: 400 });

    const file = await readUserFile(userId, key);
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(new Uint8Array(file.content), {
        headers: {
            "content-type": file.mime_type,
            "content-length": String(file.bytes),
            "cache-control": "private, no-store",
        },
    });
}
