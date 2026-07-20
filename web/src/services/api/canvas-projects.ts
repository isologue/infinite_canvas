"use client";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

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

export type CanvasProjectSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt"> & {
    nodeCount: number;
    connectionCount: number;
};

type ApiPayload<T> = { code: number; data?: T; msg?: string };
type SaveState = { timer: ReturnType<typeof setTimeout> | null; queued: CanvasProject | null; active: Promise<void> | null };

const saveStates = new Map<string, SaveState>();

export async function fetchCanvasProjects() {
    const payload = await apiRequest<ApiPayload<{ projects: CanvasProjectSummary[] }>>("/api/user/projects");
    return payload.data?.projects || [];
}

export async function fetchCanvasProject(id: string) {
    const payload = await apiRequest<ApiPayload<{ project: CanvasProject }>>(`/api/user/projects/${encodeURIComponent(id)}`);
    if (!payload.data?.project) throw new Error(payload.msg || "画布不存在");
    return payload.data.project;
}

export async function fetchAllCanvasProjects() {
    const projects = await fetchCanvasProjects();
    return Promise.all(projects.map((project) => fetchCanvasProject(project.id)));
}

export async function createCanvasProject(project: CanvasProject) {
    const payload = await apiRequest<ApiPayload<{ project: CanvasProject }>>("/api/user/projects", { method: "POST", body: JSON.stringify({ project: sanitizeCanvasProject(project) }) });
    if (!payload.data?.project) throw new Error(payload.msg || "创建画布失败");
    return payload.data.project;
}

export async function renameCanvasProject(id: string, title: string) {
    const payload = await apiRequest<ApiPayload<{ project: CanvasProjectSummary }>>(`/api/user/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
    if (!payload.data?.project) throw new Error(payload.msg || "重命名失败");
    return payload.data.project;
}

export async function deleteCanvasProjects(ids: string[]) {
    await Promise.all(ids.map((id) => flushCanvasProjectSaves(id)));
    await apiRequest("/api/user/projects", { method: "DELETE", body: JSON.stringify({ ids }) });
    ids.forEach((id) => saveStates.delete(id));
}

export function queueCanvasProjectSave(project: CanvasProject) {
    const state = saveStates.get(project.id) || { timer: null, queued: null, active: null };
    state.queued = sanitizeCanvasProject({ ...project, updatedAt: new Date().toISOString() });
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        state.timer = null;
        void runSave(project.id, state).catch(() => undefined);
    }, 400);
    saveStates.set(project.id, state);
}

export async function flushCanvasProjectSaves(projectId?: string) {
    const entries = projectId ? [...saveStates.entries()].filter(([id]) => id === projectId) : [...saveStates.entries()];
    await Promise.all(entries.map(async ([id, state]) => {
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        await runSave(id, state);
        if (state.active) await state.active;
        if (state.queued) await runSave(id, state);
    }));
}

export function sanitizeCanvasProject(project: CanvasProject) {
    return sanitizeStorageUrls(project) as CanvasProject;
}

function runSave(id: string, state: SaveState) {
    if (state.active || !state.queued) return state.active || Promise.resolve();
    const project = state.queued;
    let failed = false;
    state.queued = null;
    state.active = apiRequest(`/api/user/projects/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ project }) })
        .then(() => undefined)
        .catch((error) => {
            failed = true;
            if (!state.queued) state.queued = project;
            throw error;
        })
        .finally(() => {
            state.active = null;
            if (!failed && state.queued) void runSave(id, state).catch(() => undefined);
        });
    return state.active;
}

function sanitizeStorageUrls(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sanitizeStorageUrls);
    const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    if (typeof next.storageKey === "string" && next.storageKey) {
        if ("content" in next) next.content = "";
        if ("dataUrl" in next) next.dataUrl = "";
        if ("url" in next) next.url = "";
        if ("coverUrl" in next) next.coverUrl = "";
    }
    Object.keys(next).forEach((key) => {
        if (next[key] && typeof next[key] === "object") next[key] = sanitizeStorageUrls(next[key]);
    });
    return next;
}

async function apiRequest<T = ApiPayload<unknown>>(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const payload = (await response.json().catch(() => null)) as T & { msg?: string };
    if (!response.ok) throw new Error(payload?.msg || "请求失败");
    return payload;
}
