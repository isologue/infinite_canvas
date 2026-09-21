import { readSessionUser } from "@/lib/server/auth";
import { readPromptImage } from "@/lib/server/prompt-resource-db";
import { readPromptSourceSettings } from "@/lib/server/prompt-source-db";
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
    const user = await readSessionUser();
    if (!user) return new Response("Unauthorized", { status: 401 });
    const { id } = await context.params;
    const settings = user.role === "admin" ? null : await readPromptSourceSettings();
    const sourceIds = settings?.sources.filter((source) => source.enabled).map((source) => source.id);
    const image = await readPromptImage(decodeURIComponent(id), sourceIds);
    if (!image) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(image.content), { headers: { "content-type": image.mimeType, "content-length": String(image.bytes), "cache-control": "private, max-age=31536000, immutable", etag: `\"${image.etag}\"` } });
}
