import { readSessionUser } from "@/lib/server/auth";

export async function GET() {
    const session = await readSessionUser();
    if (!session) return Response.json({ code: 0, data: { user: null } });
    return Response.json({
        code: 0,
        data: {
            user: {
                id: session.id,
                username: session.username,
                displayName: session.displayName,
                avatarUrl: session.avatarUrl,
                role: session.role,
            },
        },
    });
}
