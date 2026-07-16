export function registerGeneratedTextResource(input: { title?: string; content: string; source?: string; metadata?: unknown }) {
    if (!input.content.trim()) return Promise.resolve();
    return fetch("/api/user/resources/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    }).then(() => undefined).catch(() => undefined);
}
