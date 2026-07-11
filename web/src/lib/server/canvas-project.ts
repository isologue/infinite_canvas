export function normalizeCanvasProject(value: unknown) {
    if (!value || typeof value !== "object") return null;
    const project = value as Record<string, unknown>;
    if (typeof project.id !== "string" || !project.id.trim() || typeof project.title !== "string") return null;
    const now = new Date().toISOString();
    const backgroundMode = project.backgroundMode === "dots" || project.backgroundMode === "blank" ? project.backgroundMode : "lines";
    const viewport = project.viewport && typeof project.viewport === "object" ? (project.viewport as Record<string, unknown>) : {};
    return {
        id: project.id.trim(),
        title: project.title.trim() || "未命名画布",
        createdAt: typeof project.createdAt === "string" ? project.createdAt : now,
        updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : now,
        nodes: Array.isArray(project.nodes) ? project.nodes : [],
        connections: Array.isArray(project.connections) ? project.connections : [],
        chatSessions: Array.isArray(project.chatSessions) ? project.chatSessions : [],
        activeChatId: typeof project.activeChatId === "string" ? project.activeChatId : null,
        backgroundMode,
        showImageInfo: Boolean(project.showImageInfo),
        viewport: {
            x: typeof viewport.x === "number" && Number.isFinite(viewport.x) ? viewport.x : 0,
            y: typeof viewport.y === "number" && Number.isFinite(viewport.y) ? viewport.y : 0,
            k: typeof viewport.k === "number" && Number.isFinite(viewport.k) && viewport.k > 0 ? viewport.k : 1,
        },
    };
}
