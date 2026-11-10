const BASE64_VALUE_PATTERN = /^(?:data:[^;,]+;base64,)?[A-Za-z0-9+/\r\n]+={0,2}$/;
const BASE64_VALUE_MIN_LENGTH = 4096;

function compactBinaryValue(value: string) {
    if (value.length < BASE64_VALUE_MIN_LENGTH || !BASE64_VALUE_PATTERN.test(value)) return value;
    const comma = value.indexOf(",");
    const prefix = comma >= 0 ? value.slice(0, comma + 1) : "";
    return `${prefix}[base64 内容已省略，共 ${value.length - prefix.length} 个字符]`;
}

// 日志保留真实请求/响应结构与普通文本；仅省略无法直接排障且会显著撑大数据库的二进制 base64 内容。
export function prepareAiLogValue(value: unknown): unknown {
    const visited = new WeakSet<object>();
    const walk = (current: unknown): unknown => {
        if (typeof current === "string") return compactBinaryValue(current);
        if (current === null || current === undefined || typeof current !== "object") return current;
        if (typeof Blob !== "undefined" && current instanceof Blob) {
            return {
                ...(typeof File !== "undefined" && current instanceof File ? { name: current.name } : {}),
                type: current.type,
                bytes: current.size,
            };
        }
        if (visited.has(current)) return "[循环引用]";
        visited.add(current);
        if (Array.isArray(current)) return current.map(walk);
        return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    };
    return walk(value);
}

