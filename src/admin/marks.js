import { useCallback, useEffect, useState } from "react";
import { getMarks, setMark } from "./api.js";

/* Operator marks: checked / good, favourite, and the wallet balance bucket.
 * The server keeps them in one JSON file, so a refresh, a second browser or
 * another process all see the same values. */
export function useMarks(email) {
  const [marks, setMarks] = useState({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await getMarks(email ? { email } : {});
      setMarks(data?.marks || {});
    } catch {
      // A marks file that cannot be read must not break the grid.
    }
  }, [email]);

  useEffect(() => {
    reload();
  }, [reload]);

  const update = useCallback(
    async (path, patch) => {
      setBusy(true);
      try {
        const data = await setMark({ email, path, ...patch });
        setMarks(data?.marks || {});
      } finally {
        setBusy(false);
      }
    },
    [email]
  );

  return { marks, update, reload, busy };
}

export function markOf(marks, email, path) {
  if (!email || !path) return null;
  return marks[`${String(email).toLowerCase()}/${path}`] || null;
}

export const BALANCE_LABEL = {
  "0": "$0",
  "1k": "$1k",
  "10k": "$10k",
  "100k": "$100k",
};
