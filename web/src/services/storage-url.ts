export function storageFileUrl(storageKey: string) {
    return `/api/storage/files/${encodeURIComponent(storageKey)}`;
}
