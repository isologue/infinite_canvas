"use client";

import { nanoid } from "nanoid";
import { create } from "zustand";

import { createCanvasProject, deleteCanvasProjects, fetchCanvasProjects, renameCanvasProject, type CanvasProject, type CanvasProjectSummary } from "@/services/api/canvas-projects";

export type { CanvasProject, CanvasProjectSummary } from "@/services/api/canvas-projects";

type CanvasStore = {
    hydrated: boolean;
    loading: boolean;
    projects: CanvasProjectSummary[];
    loadProjects: () => Promise<CanvasProjectSummary[]>;
    createProject: (title?: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>) => Promise<string>;
    renameProject: (id: string, title: string) => Promise<void>;
    deleteProjects: (ids: string[]) => Promise<void>;
    replaceProjects: (projects: CanvasProject[]) => Promise<void>;
};

const initialViewport = { x: 0, y: 0, k: 1 };
let loadPromise: Promise<CanvasProjectSummary[]> | null = null;

export const useCanvasStore = create<CanvasStore>((set, get) => ({
    hydrated: false,
    loading: false,
    projects: [],
    loadProjects: async () => {
        if (loadPromise) return loadPromise;
        set({ loading: true });
        loadPromise = fetchCanvasProjects()
            .then((projects) => {
                set({ projects, hydrated: true });
                return projects;
            })
            .catch(() => {
                set({ projects: [], hydrated: true });
                return [];
            })
            .finally(() => {
                loadPromise = null;
                set({ loading: false });
            });
        return loadPromise;
    },
    createProject: async (title = "未命名画布") => {
        const now = new Date().toISOString();
        const project = await createCanvasProject({ id: nanoid(), title, createdAt: now, updatedAt: now, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: initialViewport });
        set((state) => ({ projects: [summary(project), ...state.projects] }));
        return project.id;
    },
    importProject: async (source) => {
        const now = new Date().toISOString();
        const project = await createCanvasProject({
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
        });
        set((state) => ({ projects: [summary(project), ...state.projects] }));
        return project.id;
    },
    renameProject: async (id, title) => {
        const current = get().projects.find((project) => project.id === id);
        const nextTitle = title.trim() || current?.title;
        if (!nextTitle) return;
        const project = await renameCanvasProject(id, nextTitle);
        set((state) => ({ projects: state.projects.map((item) => (item.id === id ? project : item)) }));
    },
    deleteProjects: async (ids) => {
        await deleteCanvasProjects(ids);
        set((state) => ({ projects: state.projects.filter((project) => !ids.includes(project.id)) }));
    },
    replaceProjects: async (projects) => {
        await Promise.all(projects.map(createCanvasProject));
        await get().loadProjects();
    },
}));

function summary(project: CanvasProject): CanvasProjectSummary {
    return { id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, nodeCount: project.nodes.length, connectionCount: project.connections.length };
}
