import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { trackPageview } from "@/lib/analytics";

// Observe SPA route changes and report page views; trackPageview is a no-op when analytics is not configured.
export function AnalyticsTracker() {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const search = searchParams.toString();

    useEffect(() => {
        trackPageview(`${pathname}${search ? `?${search}` : ""}`);
    }, [pathname, search]);

    return null;
}
