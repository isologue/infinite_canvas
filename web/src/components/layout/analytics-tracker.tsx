import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { trackPageview } from "@/lib/analytics";

// 监听 SPA 路由变化并上报 pageview。无统计配置时 trackPageview 为空操作。
export function AnalyticsTracker() {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const search = searchParams.toString();

    useEffect(() => {
        trackPageview(`${pathname}${search ? `?${search}` : ""}`);
    }, [pathname, search]);

    return null;
}
