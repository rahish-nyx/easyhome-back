import "dotenv/config";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:5000/api";

function envValue(key) {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

const email = envValue("ADMIN_EMAIL");
const password = envValue("ADMIN_PASSWORD");

async function json(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 160);
  }
  return { status: res.status, body, size: text.length };
}

const login = await json("/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, role: "admin" }),
});

if (login.status !== 200) {
  console.log("LOGIN FAILED", login.status, JSON.stringify(login.body).slice(0, 300));
  process.exit(1);
}

const token =
  login.body?.token ||
  login.body?.accessToken ||
  login.body?.idToken ||
  login.body?.session?.token;
if (!token) {
  console.log("NO TOKEN IN RESPONSE", Object.keys(login.body || {}));
  process.exit(1);
}
console.log("admin login ok");

const headers = { Authorization: `Bearer ${token}` };
const routes = [
  "/admin/overview",
  "/admin/users?limit=5",
  "/admin/workers?limit=5",
  "/admin/bookings?limit=5",
  "/admin/chats",
  "/admin/call-requests",
  "/admin/referrals",
  "/admin/admins",
  "/admin/audit?limit=5",
  "/admin/subscriptions",
  "/admin/commissions",
  "/admin/revenue",
  "/admin/services",
  "/admin/cities",
  "/admin/promos",
  "/admin/footer-links",
  "/admin/settings",
  "/admin/zones",
  "/admin/live-tracking",
  "/admin/waitlist",
  "/admin/folders",
];

let failures = 0;
for (const route of routes) {
  const out = await json(route, { headers });
  const flag = out.status === 200 ? "ok  " : "FAIL";
  if (out.status !== 200) failures += 1;
  const detail =
    out.status === 200
      ? `${out.size}b`
      : JSON.stringify(out.body).slice(0, 140);
  console.log(`${flag} ${route.padEnd(30)} ${out.status} ${detail}`);
}
console.log(failures ? `${failures} endpoint(s) failed` : "all admin endpoints healthy");
process.exit(failures ? 1 : 0);
