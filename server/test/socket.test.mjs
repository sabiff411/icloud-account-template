import { io } from "socket.io-client";

const URL = "http://127.0.0.1:4001";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(nsp, auth = {}) {
  return new Promise((resolve, reject) => {
    const s = io(URL + nsp, { auth, transports: ["websocket"] });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout " + nsp)), 5000);
  });
}

const call = (s, event, data) =>
  new Promise((resolve, reject) => {
    s.timeout(5000).emit(event, data, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
};

try {
  // Wrong password must be rejected.
  try {
    await connect("/admin", { password: "wrong" });
    check("admin rejects wrong password", false);
  } catch (error) {
    check("admin rejects wrong password", /unauthorized/.test(error.message), error.message);
  }

  const pub = await connect("/public");
  check("public connects", true);
  const hello = await call(pub, "public:hello", { page: "/sign-in" });
  check("public:hello", hello.ok === true, JSON.stringify(hello));

  let notice = null;
  pub.on("public:notice", (data) => (notice = data));

  const admin = await connect("/admin", {
    password: process.env.ADMIN_PASSWORD || "change-me-admin",
  });
  check("admin connects with password", true);

  const listed = await call(admin, "admin:list", { page: 1, pageSize: 5 });
  check("admin:list", listed.ok && Array.isArray(listed.items), `items=${listed.items?.length}`);

  const submit = await call(pub, "public:submit", {
    email: `socket-test-${Date.now()}@example.com`,
    password: "test-password",
    code: "424242",
    page: "/verify",
  });
  check("public:submit", submit.ok && submit.id, submit.id ?? "");

  const got = await call(admin, "admin:get", { id: submit.id });
  check(
    "admin:get new item",
    got.ok && got.item.code === "424242" && got.item.password === "test-password"
  );

  const updated = await call(admin, "admin:update", {
    id: submit.id,
    status: "reviewed",
    note: "seen by test",
  });
  check("admin:update", updated.ok && updated.item.status === "reviewed");

  const stats = await call(admin, "admin:stats", {});
  check("admin:stats", stats.ok && stats.stats.total > 0);

  const sent = await call(admin, "admin:notice", { title: "Hi", body: "test" });
  await wait(200);
  check("admin:notice reaches public", sent.ok && notice?.title === "Hi");

  const deleted = await call(admin, "admin:delete", { id: submit.id });
  check("admin:delete", deleted.ok);

  pub.close();
  admin.close();
} catch (error) {
  check("unexpected error", false, error.stack);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
