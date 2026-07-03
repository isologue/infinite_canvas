import { readSessionUser } from "@/lib/server/auth";
import { readUserFile } from "@/lib/server/user-data-db";

export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
    const user = await readSessionUser();
    if (!user) return new Response("Unauthorized", { status: 401 });
    const { key } = await context.params;
    const file = await readUserFile(user.id, decodeURIComponent(key));
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(file.content, {
        headers: {
            "content-type": file.mime_type,
            "content-length": file.bytes,
            "cache-control": "private, no-store",
        },
    });
}
