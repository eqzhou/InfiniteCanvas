import { useEffect } from "react";
import { useLocation } from "react-router";
import { trackPageview } from "@/lib/analytics";

export function AnalyticsTracker() {
  const location = useLocation();
  useEffect(() => {
    trackPageview(`${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);
  return null;
}
