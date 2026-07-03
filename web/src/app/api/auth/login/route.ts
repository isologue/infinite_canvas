import { NextRequest } from "next/server";

import { authenticateUser, publicUser, writeSessionCookie } from "@/lib/server/auth";

export async function POST(request: NextRequest) {
    const body = (await request.json().catch(() => null)) as { username?: string; password?: string } | null;
    const username = body?.username?.trim() || "";
    const password = body?.password || "";
    if (!username || !password) return Response.json({ code: 400, msg: "请输入用户名和密码" }, { status: 400 });
    const user = await authenticateUser(username, password);
    if (!user) return Response.json({ code: 401, msg: "账号或密码错误" }, { status: 401 });
    await writeSessionCookie(publicUser(user));
    return Response.json({
        code: 0,
        msg: "登录成功",
        data: {
            user: publicUser(user),
        },
    });
}
