"use client";

import { nanoid } from "nanoid";
import { create } from "zustand";

export type UploadKind = "image" | "video" | "audio" | "file";
export type UploadStatus = "preparing" | "uploading" | "processing" | "success" | "error";
export type UploadRecord = {
    id: string;
    name: string;
    kind: UploadKind;
    status: UploadStatus;
    progress: number;
    bytes: number;
    error?: string;
};

type UploadStore = {
    records: UploadRecord[];
    collapsed: boolean;
    hidden: boolean;
    start: (name: string, kind: UploadKind, bytes: number) => string;
    update: (id: string, patch: Partial<Pick<UploadRecord, "status" | "progress" | "bytes" | "error">>) => void;
    setCollapsed: (collapsed: boolean) => void;
    setHidden: (hidden: boolean) => void;
    clearFinished: () => void;
    reset: () => void;
};

export function isUploadActive(record: UploadRecord) {
    return record.status !== "success" && record.status !== "error";
}

export const useUploadStore = create<UploadStore>((set) => ({
    records: [],
    collapsed: false,
    hidden: false,
    start: (name, kind, bytes) => {
        const id = nanoid();
        set((state) => ({ records: [{ id, name, kind, bytes, progress: 0, status: "preparing" }, ...state.records], hidden: false }));
        return id;
    },
    update: (id, patch) => set((state) => ({
        records: state.records.map((record) => record.id === id ? { ...record, ...patch } : record),
    })),
    setCollapsed: (collapsed) => set({ collapsed }),
    setHidden: (hidden) => set({ hidden }),
    clearFinished: () => set((state) => ({ records: state.records.filter(isUploadActive) })),
    reset: () => set({ records: [], collapsed: false, hidden: false }),
}));
