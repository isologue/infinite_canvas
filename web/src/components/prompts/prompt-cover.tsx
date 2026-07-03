"use client";

import { ImageOff } from "lucide-react";
import { useMemo, useState } from "react";

import { promptCoverSrc } from "@/services/api/prompts";

export function PromptCover({ src, alt, className }: { src: string; alt: string; className?: string }) {
    const initialSrc = useMemo(() => promptCoverSrc(src), [src]);
    const [failed, setFailed] = useState(false);

    if (!initialSrc || failed) {
        return (
            <div className={`flex items-center justify-center bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600 ${className || ""}`}>
                <ImageOff className="size-8" />
            </div>
        );
    }

    return <img src={initialSrc} alt={alt} className={className} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
