export type EditableFileKind = "ppt" | "psd" | "svg";
export type EditableFileStatus = "queued" | "running" | "success" | "error";

export type EditableFileResult = {
    conversation_id?: string;
    primary_url?: string;
    zip_url?: string;
};

export type EditableFileTask = {
    id: string;
    taskId: string;
    kind: EditableFileKind;
    status: EditableFileStatus;
    created_at: string;
    updated_at: string;
    elapsed_seconds: number;
    result?: EditableFileResult;
    error?: { code?: string; message?: string };
};

export type StoredEditableFile = {
    storageKey: string;
    mimeType: string;
    bytes: number;
    url?: string;
};

export type EditableFileLog = {
    id: string;
    createdAt: number;
    kind: EditableFileKind;
    title: string;
    prompt: string;
    model: string;
    referenceImageCount?: number;
    files?: { primary?: StoredEditableFile; zip?: StoredEditableFile };
    storageError?: string;
    task?: EditableFileTask;
    status: EditableFileStatus;
    error?: string;
};
