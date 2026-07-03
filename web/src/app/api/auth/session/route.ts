import { findUserById, getReservedCredits, readSessionUser } from "@/lib/server/auth";

export async function GET() {
    const session = await readSessionUser();
    if (!session) return Response.json({ code: 0, data: { user: null } });
    // cookie 里的 creditBalance 是登录时的快照，扣点数只改数据库不更新 cookie，
    // 所以这里从数据库读最新余额，避免 F5 后余额回退到旧值。
    const [dbUser, reservedCredits] = await Promise.all([
        findUserById(session.id).catch(() => null),
        getReservedCredits(session.id).catch(() => 0),
    ]);
    const user = dbUser || session;
    return Response.json({
        code: 0,
        data: {
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                avatarUrl: user.avatarUrl,
                role: user.role,
                creditBalance: user.creditBalance,
                reservedCredits,
            },
        },
    });
}
