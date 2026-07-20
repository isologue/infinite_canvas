import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const files = await readdir(resolve(process.cwd(), "public/plugins"));
        return Response.json(files.filter((file) => file.endsWith(".js")).sort().map((file) => `/plugins/${file}`), { headers: { "cache-control": "no-store" } });
    } catch {
        return Response.json([], { headers: { "cache-control": "no-store" } });
    }
}
