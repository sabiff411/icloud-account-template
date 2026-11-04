import { useEffect, useState } from "react";

const NAV_EVENT = "app:navigate";

export function usePath() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);
  return path;
}

export function navigate(to) {
  if (window.location.pathname !== to) window.history.pushState({}, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
}
