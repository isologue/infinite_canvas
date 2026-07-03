import { clearSessionCookie } from "@/lib/server/auth";

export async function POST() {
    await clearSessionCookie();
    return Response.json({ code: 0, msg: "已退出登录" });
}
