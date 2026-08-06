import { NextRequest } from "next/server";

import { readSessionUser } from "@/lib/server/auth";
import { readVideoDownloadSettings, writeVideoDownloadSettings } from "@/lib/server/video-download-settings-db";

export async function GET() {
    const user = await readSessionUser();
    if (user?.role !== "admin") return Response.json({ code: 403, msg: "Administrator access is required" }, { status: 403 });
    try {
        return Response.json({ code: 0, data: await readVideoDownloadSettings() });
    } catch (error) {
        return Response.json({ code: 500, msg: error instanceof Error ? error.message : "Failed to read video transfer settings" }, { status: 500 });
    }
}

export async function PUT(request: NextRequest) {
    const user = await readSessionUser();
    if (user?.role !== "admin") return Response.json({ code: 403, msg: "Administrator access is required" }, { status: 403 });
    try {
        return Response.json({ code: 0, msg: "Video transfer settings saved", data: await writeVideoDownloadSettings(await request.json()) });
    } catch (error) {
        return Response.json({ code: 400, msg: error instanceof Error ? error.message : "Failed to save video transfer settings" }, { status: 400 });
    }
}
