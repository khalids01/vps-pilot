import { useLayoutEffect, useState } from "react";

// Portalled dialogs share the actual tab-bar boundary, including zoom and notices.
export function useModalBoundary() {
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!bar) return;
    const root = document.documentElement;
    function measure() {
      if (!bar) return;
      const zoom = Number.parseFloat(getComputedStyle(root).zoom) || 1;
      const value = `${Math.max(0, bar.getBoundingClientRect().bottom / zoom)}px`;
      if (root.style.getPropertyValue("--vps-tabs-bottom") !== value)
        root.style.setProperty("--vps-tabs-bottom", value);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (bar.parentElement) observer.observe(bar.parentElement);
    const styleObserver = new MutationObserver(measure);
    styleObserver.observe(root, {
      attributes: true,
      attributeFilter: ["style"],
    });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      styleObserver.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--vps-tabs-bottom");
    };
  }, [bar]);
  return setBar;
}
