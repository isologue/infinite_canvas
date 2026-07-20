"use client";

import { Suspense } from "react";
import CanvasProjectPage from "@/pages/canvas/project";

export default function CanvasPage() {
    return (
        <Suspense fallback={<main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在加载画布...</main>}>
            <CanvasProjectPage />
        </Suspense>
    );
}
