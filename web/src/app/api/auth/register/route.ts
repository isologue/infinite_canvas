import { NextRequest } from "next/server";

import { createUser, findUserByUsername, publicUser, writeSessionCookie } from "@/lib/server/auth";

export async function POST(request: NextRequest) {
    const body = (await request.json().catch(() => null)) as { username?: string; password?: string; displayName?: string } | null;
    const username = body?.username?.trim() || "";
    const password = body?.password || "";
    const displayName = body?.displayName?.trim() || username;
    if (!username || !password) return Response.json({ code: 400, msg: "请输入用户名和密码" }, { status: 400 });
    if (password.length < 6) return Response.json({ code: 400, msg: "密码至少 6 位" }, { status: 400 });
    if (await findUserByUsername(username)) return Response.json({ code: 409, msg: "用户名已存在" }, { status: 409 });
    const user = await createUser({ username, password, displayName });
    await writeSessionCookie(publicUser(user));
    return Response.json({
        code: 0,
        msg: "注册成功",
        data: {
            user: publicUser(user),
        },
    });
}
