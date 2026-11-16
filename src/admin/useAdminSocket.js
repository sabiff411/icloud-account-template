import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { SOCKET_URL } from "../lib/socket";

/* Admin socket state machine. The password is sent once in the handshake;
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
  accounts: [],
  wave: null,
  accountsTotal: 0,
  accountPage: 1,
  accountPages: 1,
  accountPageSize: 1000,
  accountsQuery: "",
  accountScope: "visible",
  accountStats: null,
  jobs: null,
  workers: null,
  exportEnabled: true,
  selectedAccount: null,
  accountJobs: [],
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

  const loadAccounts = useCallback(
    async (page = 1, query = "", scope = state.accountScope) => {
      try {
        const result = await emit("admin:accounts", {
          page,
          pageSize: state.accountPageSize,
          query,
          scope,
        });
        setState((prev) => ({
          ...prev,
          accounts: result.accounts.items,
          accountsTotal: result.accounts.total,
          wave: result.wave ?? prev.wave,
          accountPage: result.accounts.page,
          accountPages: result.accounts.pages,
          accountsQuery: query,
          accountScope: scope,
          accountStats: result.stats ?? prev.accountStats,
          jobs: result.jobs ?? prev.jobs,
          workers: result.workers ?? prev.workers,
          exportEnabled: result.exportEnabled ?? prev.exportEnabled,
        }));
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note, state.accountPageSize, state.accountScope]
  );

  const connect = useCallback(
    (password) => {
      socketRef.current?.disconnect();
      // No password means the signed cookie from POST /api/admin/login.
      const socket = io(`${SOCKET_URL}/admin`, {
        auth: password ? { password } : {},
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

      socket.on("admin:ready", (payload) => {
        setState((prev) => ({
          ...prev,
          stats: payload.stats,
          items: payload.page?.items ?? prev.items,
          total: payload.page?.total ?? prev.total,
          page: payload.page?.page ?? prev.page,
          pages: payload.page?.pages ?? prev.pages,
          accounts: payload.accounts?.items ?? prev.accounts,
          accountsTotal: payload.accounts?.total ?? prev.accountsTotal,
          wave: payload.wave ?? prev.wave,
          accountPage: payload.accounts?.page ?? prev.accountPage,
          accountPages: payload.accounts?.pages ?? prev.accountPages,
          accountStats: payload.accountStats ?? prev.accountStats,
          jobs: payload.jobs ?? prev.jobs,
          workers: payload.workers ?? prev.workers,
          exportEnabled: payload.exportEnabled ?? prev.exportEnabled,
        }));
      });

      socket.on("admin:wave", (wave) => {
        setState((prev) => ({ ...prev, wave: wave ?? null }));
      });

      socket.on("admin:workers", (workers) => {
        setState((prev) => ({ ...prev, workers: workers ?? prev.workers }));
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
        setState((prev) => {
          const current = prev.page;
          socket.emit(
            "admin:list",
            { page: current, pageSize: prev.pageSize, query: prev.query },
            (result) => {
              if (result?.ok) {
                setState((p) => ({
                  ...p,
                  items: result.items,
                  total: result.total,
                  page: result.page,
                  pages: result.pages,
                }));
              }
            }
          );
          return prev;
        });
      });

      // Account updates are pushed for every store mutation (login, 2FA,
      // count snapshot, export progress). Update the visible row in place and
      // keep a detail drawer in sync.
      socket.on("admin:account", ({ account, stats: accountStats }) => {
        setState((prev) => {
          const scope = prev.accountScope;
          const matches =
            scope === "all" ||
            (scope === "hidden" ? account.hidden : !account.hidden);
          const exists = prev.accounts.some((item) => item.id === account.id);
          let accounts = prev.accounts;
          if (!matches) {
            accounts = prev.accounts.filter((item) => item.id !== account.id);
          } else if (exists) {
            accounts = prev.accounts.map((item) =>
              item.id === account.id ? account : item
            );
          } else if (prev.accountPage === 1) {
            accounts = [account, ...prev.accounts].slice(0, prev.accountPageSize);
          }
          return {
            ...prev,
            accountStats: accountStats ?? prev.accountStats,
            accounts,
            accountsTotal:
              prev.accountsTotal +
              (matches && !exists ? 1 : !matches && exists ? -1 : 0),
            selectedAccount:
              prev.selectedAccount?.id === account.id
                ? { ...prev.selectedAccount, ...account }
                : prev.selectedAccount,
          };
        });
      });

      socket.on("admin:job", ({ job, change }) => {
        note(`job ${change}: ${job.type} ${job.status}`);
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

  const openAccount = useCallback(
    async (id) => {
      try {
        const result = await emit("admin:account", { id });
        setState((prev) => ({
          ...prev,
          selectedAccount: result.account,
          accountJobs: result.jobs ?? [],
        }));
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const clearAccount = useCallback(() => {
    setState((prev) => ({ ...prev, selectedAccount: null, accountJobs: [] }));
  }, []);

  const pingAccount = useCallback(
    async (id) => {
      try {
        const result = await emit("admin:ping", { id });
        note(result.reused ? "ping already running" : "ping queued");
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const exportAccount = useCallback(
    async (id, mode = "missing") => {
      try {
        const result = await emit("admin:export", { id, mode });
        note(result.reused ? "export already running" : `${mode} export queued`);
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const importAccount = useCallback(
    async (path, email) => {
      const result = await emit("admin:import", { path, email });
      note(result.reused ? "import already running" : "import queued");
      return result;
    },
    [emit, note]
  );

  const verifyAccount = useCallback(
    async (id) => {
      try {
        const result = await emit("admin:verify", { id });
        note(result.reused ? "verify already running" : "live verify queued");
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const scanAccount = useCallback(
    async (id) => {
      try {
        const result = await emit("admin:scan", { id });
        note(result.reused ? "scan already running" : "OCR + seed scan queued");
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note]
  );

  const scanAll = useCallback(async () => {
    const result = await emit("admin:scan_all", {});
    note(`scan all: ${result.queued} queued, ${result.reused} already running`);
    return result;
  }, [emit, note]);

  const hideAccount = useCallback(
    async (id, hidden = true) => {
      try {
        const result = await emit("admin:hide", { id, hidden });
        setState((prev) => ({
          ...prev,
          selectedAccount:
            prev.selectedAccount?.id === id
              ? { ...prev.selectedAccount, ...result.account }
              : prev.selectedAccount,
        }));
        note(hidden ? "account hidden (files kept)" : "account shown again");
        await loadAccounts(state.accountPage, state.accountsQuery, state.accountScope);
      } catch (error) {
        note(error.message);
      }
    },
    [emit, note, loadAccounts, state.accountPage, state.accountsQuery, state.accountScope]
  );

  const hideAll = useCallback(async () => {
    try {
      const result = await emit("admin:hideAll", {});
      note(`${result.hidden} account(s) hidden`);
      await loadAccounts(1, state.accountsQuery, state.accountScope);
    } catch (error) {
      note(error.message);
    }
  }, [emit, note, loadAccounts, state.accountsQuery, state.accountScope]);

  const recheckAll = useCallback(async () => {
    try {
      const result = await emit("admin:recheckAll", {});
      note(
        result.queued
          ? `recheck queued for ${result.queued}/${result.total} live account(s)`
          : "no live accounts to recheck"
      );
    } catch (error) {
      note(error.message);
    }
  }, [emit, note]);

  const refreshAll = useCallback(async () => {
    try {
      const result = await emit("admin:refresh", {
        page: state.accountPage,
        pageSize: state.accountPageSize,
        query: state.accountsQuery,
        scope: state.accountScope,
      });
      setState((prev) => ({
        ...prev,
        accounts: result.accounts.items,
        accountsTotal: result.accounts.total,
        accountPage: result.accounts.page,
        accountPages: result.accounts.pages,
        accountStats: result.stats ?? prev.accountStats,
        jobs: result.jobs ?? prev.jobs,
        workers: result.workers ?? prev.workers,
      }));
      note("accounts refreshed");
    } catch (error) {
      note(error.message);
    }
  }, [emit, note, state.accountPage, state.accountPageSize, state.accountsQuery, state.accountScope]);

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
    loadAccounts,
    openItem,
    clearSelected,
    saveItem,
    deleteItem,
    openAccount,
    clearAccount,
    pingAccount,
    exportAccount,
    importAccount,
    verifyAccount,
    scanAccount,
    scanAll,
    hideAccount,
    hideAll,
    recheckAll,
    refreshAll,
    sendNotice,
  };
}
