import { NextRequest } from "next/server";

import { createUser, deleteUser, getReservedCreditsForUsers, publicUser, readSessionUser, updateUser, listUsers, type DbUser } from "@/lib/server/auth";

function unauthorized() {
    return Response.json({ code: 403, msg: "只有超级管理员可以访问" }, { status: 403 });
}

export async function GET() {
    const user = await readSessionUser();
    if (user?.role !== "admin") return unauthorized();
    const users = await listUsers();
    const reserved = await getReservedCreditsForUsers(users.map((u: DbUser) => u.id));
    return Response.json({
        code: 0,
        data: { users: users.map((u: DbUser) => ({ ...publicUser(u), reservedCredits: reserved.get(u.id) || 0 })) },
    });
}

export async function POST(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return unauthorized();
    const body = (await request.json().catch(() => null)) as { username?: string; password?: string; displayName?: string; role?: "admin" | "user"; creditBalance?: number } | null;
    const username = body?.username?.trim() || "";
    const password = body?.password || "";
    if (!username || !password) return Response.json({ code: 400, msg: "请输入用户名和密码" }, { status: 400 });
    const created = await createUser({
        username,
        password,
        displayName: body?.displayName,
        role: body?.role || "user",
        creditBalance: Number(body?.creditBalance || 0),
    });
    return Response.json({ code: 0, msg: "创建成功", data: { user: publicUser(created) } });
}

export async function PUT(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return unauthorized();
    const body = (await request.json().catch(() => null)) as { id?: string; username?: string; password?: string; displayName?: string; role?: "admin" | "user"; creditBalance?: number } | null;
    if (!body?.id) return Response.json({ code: 400, msg: "缺少用户ID" }, { status: 400 });
    const updated = await updateUser({
        id: body.id,
        username: body.username,
        password: body.password || undefined,
        displayName: body.displayName,
        role: body.role,
        creditBalance: body.creditBalance,
    });
    if (!updated) return Response.json({ code: 404, msg: "用户不存在" }, { status: 404 });
    return Response.json({ code: 0, msg: "更新成功", data: { user: publicUser(updated) } });
}

export async function DELETE(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return unauthorized();
    const body = (await request.json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) return Response.json({ code: 400, msg: "缺少用户ID" }, { status: 400 });
    if (body.id === user.id) return Response.json({ code: 400, msg: "不能删除当前登录的超级管理员" }, { status: 400 });
    await deleteUser(body.id);
    return Response.json({ code: 0, msg: "删除成功" });
}
