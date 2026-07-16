import type { ReactNode } from "react";
import { connection } from "next/server";

export default async function CanvasLayout({ children }: { children: ReactNode }) {
    await connection();
    return children;
}
