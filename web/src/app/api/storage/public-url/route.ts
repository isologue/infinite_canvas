import { readSessionUser } from "@/lib/server/auth";
import { createStorageShareToken } from "@/lib/server/storage-share";
import { readUserFileInfo } from "@/lib/server/user-data-db";

type PublicUrlPayload = { storageKey?: unknown };

export async function POST(request: Request) {
    const user = await readSessionUser();
    if (!user) return Response.json({ code: 401, msg: "请先登录" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as PublicUrlPayload;
    const storageKey = typeof body.storageKey === "string" ? body.storageKey.trim() : "";
    if (!storageKey || storageKey.length > 256) return Response.json({ code: 400, msg: "缺少有效的 storageKey" }, { status: 400 });
    if (!await readUserFileInfo(user.id, storageKey)) return Response.json({ code: 404, msg: "素材不存在" }, { status: 404 });

    const { token, expiresAt } = createStorageShareToken(user.id, storageKey);
    const requestUrl = new URL(request.url);
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const origin = `${forwardedProto || requestUrl.protocol.slice(0, -1)}://${forwardedHost || request.headers.get("host") || requestUrl.host}`;
    return Response.json({ code: 0, data: { url: `${origin}/api/storage/public?token=${encodeURIComponent(token)}`, expiresAt } });
}
