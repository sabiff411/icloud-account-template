import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { SOCKET_URL } from "../lib/socket";

/* Admin socket state machine.  The password is sent once in the handshake;
 * the server rejects the connection if it is wrong, so this hook never has to
 * decide who is an admin. */

const initial = {
  status: "idle",
  error: "",
  stats: null,
  items: [],
  total: 0,
  page: 1,
  pages: 1,
  pageSize: 10,
  query: "",
  selected: null,
  log: [],
};

export function useAdminSocket() {
  const [state, setState] = useState(initial);
  const socketRef = useRef(null);

  const note = useCallback((message) => {
    setState((prev) => ({
      ...prev,
      log: [`${new Date().toLocaleTimeString()}  ${message}`, ...prev.log].slice(0, 12),
    }));
  }, []);

  const emit = useCallback((event, payload = {}) => {
    return new Promise((resolve, reject) => {
      const socket = socketRef.current;
      if (!socket?.connected) return reject(new Error("not connected"));
      socket.timeout(8000).emit(event, payload, (error, response) => {
        if (error) return reject(new Error("request timed out"));
        if (!response?.ok) return reject(new Error(response?.error ?? "failed"));
        resolve(response);
      });
    });
  }, []);

  const loadPage = useCallback(
    async (page = 1, query = "") => {
      try {
        const result = await emit("admin:list", {
          page,
          pageSize: state.pageSize,
          query,
        });
        setState((prev) => ({
          ...prev,
          items: result.items,
          total: result.total,
          page: result.page,
          pages: result.pages,
          query,
        }));
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note, state.pageSize]
  );

  const connect = useCallback(
    (password) => {
      socketRef.current?.disconnect();
      const socket = io(`${SOCKET_URL}/admin`, {
        auth: { password },
        transports: ["websocket", "polling"],
      });
      socketRef.current = socket;
      setState({ ...initial, status: "connecting" });

      socket.on("connect", () => {
        setState((prev) => ({ ...prev, status: "online", error: "" }));
        note("connected");
      });
      socket.on("connect_error", (error) => {
        setState((prev) => ({ ...prev, status: "error", error: error.message }));
      });
      socket.on("disconnect", () => {
        setState((prev) => ({ ...prev, status: "offline" }));
      });
      socket.on("admin:ready", ({ stats, page }) => {
        setState((prev) => ({
          ...prev,
          stats,
          items: page.items,
          total: page.total,
          page: page.page,
          pages: page.pages,
        }));
      });
      socket.on("admin:change", ({ stats, change }) => {
        setState((prev) => ({
          ...prev,
          stats,
          selected:
            change.type === "remove" && prev.selected?.id === change.item?.id
              ? null
              : prev.selected,
        }));
        note(`${change.type}: ${change.item?.email ?? change.item?.id ?? ""}`);
        // Keep the visible page fresh without dropping the user's place.
        setState((prev) => {
          const current = prev.page;
          socket.emit("admin:list", {
            page: current,
            pageSize: prev.pageSize,
            query: prev.query,
          }, (result) => {
            if (result?.ok) {
              setState((p) => ({
                ...p,
                items: result.items,
                total: result.total,
                page: result.page,
                pages: result.pages,
              }));
            }
          });
          return prev;
        });
      });
    },
    [note]
  );

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setState(initial);
  }, []);

  const openItem = useCallback(
    async (id) => {
      try {
        const result = await emit("admin:get", { id });
        setState((prev) => ({ ...prev, selected: result.item }));
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const clearSelected = useCallback(() => {
    setState((prev) => ({ ...prev, selected: null }));
  }, []);

  const saveItem = useCallback(
    async (id, patch) => {
      try {
        const result = await emit("admin:update", { id, ...patch });
        setState((prev) => ({ ...prev, selected: result.item }));
        note(`updated ${result.item.email}`);
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const deleteItem = useCallback(
    async (id) => {
      try {
        await emit("admin:delete", { id });
        setState((prev) => ({ ...prev, selected: null }));
        note("deleted");
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const sendNotice = useCallback(
    async (title, body) => {
      try {
        const result = await emit("admin:notice", { title, body });
        note(`notice sent to ${result.deliveredTo} visitor(s)`);
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  useEffect(() => () => socketRef.current?.disconnect(), []);

  return {
    state,
    connect,
    disconnect,
    loadPage,
    openItem,
    clearSelected,
    saveItem,
    deleteItem,
    sendNotice,
  };
}
