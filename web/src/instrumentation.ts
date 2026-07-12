declare global {
    // eslint-disable-next-line no-var
    var __infiniteCanvasResourceCleanupTimer: ReturnType<typeof setInterval> | undefined;
}

export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs" || global.__infiniteCanvasResourceCleanupTimer) return;
    const run = async () => {
        const { runResourceCleanup } = await import("@/lib/server/resource-db");
        await runResourceCleanup(false).catch(() => undefined);
    };
    void run();
    const timer = setInterval(() => void run(), 60 * 60 * 1000);
    timer.unref();
    global.__infiniteCanvasResourceCleanupTimer = timer;
}
