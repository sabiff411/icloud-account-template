import { useEffect, useRef, useState } from "react";

/* An <img> that survives a panel restart.
 *
 * When the web process is recycled, nginx answers 502 for every thumbnail for
 * a few seconds and the browser keeps that broken image until the component is
 * remounted - the grid ends up full of dark placeholders.  Retrying with a
 * short backoff and a cache-busting parameter makes the tile heal itself. */
export default function RetryImage({ src, alt = "", retries = 5, onFail, fallbackSrc, ...rest }) {
  const [attempt, setAttempt] = useState(0);
  const [useFallback, setUseFallback] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    setAttempt(0);
    setUseFallback(false);
  }, [src]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!src) return null;
  const current = useFallback && fallbackSrc ? fallbackSrc : src;
  // A presigned S4 URL signs its query string; appending rt= invalidates the
  // signature.  Cache-bust only the local routes.
  const signed = /[?&]X-Amz-Signature=/.test(current);
  const url = attempt === 0 || signed ? current : `${current}${current.includes("?") ? "&" : "?"}rt=${attempt}`;
  return (
    <img
      {...rest}
      src={url}
      alt={alt}
      onError={() => {
        if (attempt >= retries) {
          // A thumb can be missing after the local copy was pruned; show the
          // full image instead of a blank tile.
          if (!useFallback && fallbackSrc && fallbackSrc !== src) {
            setUseFallback(true);
            setAttempt(0);
            return;
          }
          onFail?.();
          return;
        }
        const delay = 300 * 2 ** attempt;
        timer.current = setTimeout(() => setAttempt((value) => value + 1), delay);
      }}
    />
  );
}
