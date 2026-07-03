import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "../types";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let pendingProjects: CanvasProject[] | null = null;
let persistSuspended = false;

async function writeProjects(projects: CanvasProject[]) {
    await fetch("/api/user/projects", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projects }),
    }).catch(() => null);
}

// 切换账号/退出时，清空内存和 rehydrate 会短暂把 projects 变空。若不暂停持久化，
// 这个空状态会被 setItem 写回服务端，覆盖掉用户真实的画布数据（曾导致数据丢失）。
// reload 期间用它挡住一切写入，重新拉到数据后再恢复。
export function suspendCanvasPersist() {
    persistSuspended = true;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    pendingProjects = null;
}

export function resumeCanvasPersist() {
    persistSuspended = false;
}

// 立即把防抖队列里待写的画布刷到服务端。切换账号 / 退出前必须调用，
// 否则最后一笔编辑（还在 400ms 防抖里）会被清空动作丢掉。
export async function flushCanvasPersist() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (pendingProjects) {
        const projects = pendingProjects;
        pendingProjects = null;
        await writeProjects(projects);
    }
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async () => {
        if (typeof window === "undefined") return null;
        try {
            const payload = (await fetch("/api/user/projects", { cache: "no-store" }).then((res) => (res.ok ? res.json() : null))) as { data?: { projects?: CanvasProject[] } } | null;
            const projects = Array.isArray(payload?.data?.projects) ? payload?.data?.projects || [] : [];
            queuedPersistState = { projects };
            return { state: { projects }, version: 0 } as StorageValue<CanvasStore>;
        } catch {
            return { state: { projects: [] as CanvasProject[] }, version: 0 } as StorageValue<CanvasStore>;
        }
    },
    setItem: (_name, value) => {
        // reload（切号/退出）期间不写服务端，避免把清空的空状态覆盖到真实数据上。
        if (persistSuspended) return;
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        pendingProjects = nextState.projects;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            const projects = pendingProjects;
            pendingProjects = null;
            if (projects) void writeProjects(projects);
        }, 400);
    },
    removeItem: async () => {
        queuedPersistState = { projects: [] };
        pendingProjects = null;
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        await writeProjects([]);
    },
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布") => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => get().projects.find((item) => item.id === id) || null,
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => ({
                    projects: state.projects.filter((project) => !ids.includes(project.id)),
                })),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
