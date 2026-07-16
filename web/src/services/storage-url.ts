export function storageFileUrl(storageKey: string) {
    return `/api/storage/files/${encodeURIComponent(storageKey)}`;
}

export function storageImagePreviewUrl(storageKey: string) {
    return `${storageFileUrl(storageKey)}?preview=1`;
}
