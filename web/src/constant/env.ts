export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";

export const DOCS_URL = process.env.NEXT_PUBLIC_DOC_URL || "https://docs.canvas.best";

// 官方插件清单地址，CI 发布到 plugins-dist 分支后通过 jsDelivr 拉取。
export const PLUGIN_REGISTRY_URL = process.env.NEXT_PUBLIC_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";
