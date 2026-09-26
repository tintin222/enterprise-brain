import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small old-style order system to try screen connections with, and for their tests: a sign-in form laid out in a table (no labels), an order list
 * with search, order pages with a status form that asks "Are you sure?", a frameset, a popup link, a link
 * to another site, and a canvas "desktop program" worked only by mouse and keyboard.
 */

export const OLD_SYSTEM_USER = "robot";
export const OLD_SYSTEM_PASSWORD = "s3cret-Pa55";

export interface OldSystem {
  url: string;
  /** Every request the system received: method and path. */
  requests: { method: string; path: string }[];
  orders: Map<string, { status: string; delivery: string; customer: string }>;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  body { font: 13px Tahoma, Arial, sans-serif; margin: 0; background: #d4d0c8; }
  .bar { background: #0a246a; color: white; padding: 6px 10px; font-weight: bold; }
  .box { background: white; border: 2px inset #999; margin: 12px; padding: 10px; }
  td, th { padding: 3px 8px; text-align: left; }
  .status { font-size: 10px; color: #555; }
  </style></head><body><div class="bar">ACME Order System v2.3</div><div class="box">${body}</div></body></html>`;

const DESK = `<!doctype html><html><head><meta charset="utf-8"><title>Remote desktop</title>
<style>body{margin:0;background:#000}canvas{display:block}</style></head><body>
<canvas id="screen" width="1280" height="800"></canvas>
<script>
const c = document.getElementById("screen"), g = c.getContext("2d");
const state = { focus: null, user: "", pass: "", signedIn: false, events: [] };
window.__desk = state;
function draw() {
  g.fillStyle = "#3a6ea5"; g.fillRect(0, 0, 1280, 800);
  g.fillStyle = "#d4d0c8"; g.fillRect(440, 250, 400, 240);
  g.fillStyle = "#0a246a"; g.fillRect(440, 250, 400, 28);
  g.fillStyle = "#fff"; g.font = "bold 14px Tahoma"; g.fillText(state.signedIn ? "Stock Control" : "Stock Control - Sign in", 450, 269);
  g.fillStyle = "#000"; g.font = "13px Tahoma";
  if (state.signedIn) {
    g.fillText("Welcome, " + state.user + ". Item A-100: 42 in stock.", 460, 320);
  } else {
    g.fillText("User:", 460, 322); g.fillText("Password:", 460, 372);
    for (const [y, key] of [[305, "user"], [355, "pass"]]) {
      g.fillStyle = "#fff"; g.fillRect(560, y, 250, 24);
      g.strokeStyle = state.focus === key ? "#0a246a" : "#808080"; g.lineWidth = 2; g.strokeRect(560, y, 250, 24);
      g.fillStyle = "#000"; g.fillText(key === "pass" ? "*".repeat(state.pass.length) : state.user, 566, y + 17);
    }
    g.fillStyle = "#d4d0c8"; g.fillRect(700, 420, 110, 30); g.strokeStyle = "#404040"; g.strokeRect(700, 420, 110, 30);
    g.fillStyle = "#000"; g.fillText("OK", 745, 440);
  }
  g.font = "9px Tahoma"; g.fillStyle = "#fff"; g.fillText("Server STK-01  build 4.2.7", 1100, 790);
}
function submit() {
  state.events.push("submit");
  state.signedIn = state.user === "${OLD_SYSTEM_USER}" && state.pass === "${OLD_SYSTEM_PASSWORD}";
  draw();
}
c.addEventListener("mousedown", (e) => {
  state.events.push("click " + e.offsetX + "," + e.offsetY + (e.shiftKey ? " shift" : ""));
  if (e.offsetX >= 560 && e.offsetX <= 810 && e.offsetY >= 305 && e.offsetY <= 329) state.focus = "user";
  else if (e.offsetX >= 560 && e.offsetX <= 810 && e.offsetY >= 355 && e.offsetY <= 379) state.focus = "pass";
  else if (e.offsetX >= 700 && e.offsetX <= 810 && e.offsetY >= 420 && e.offsetY <= 450) submit();
  else state.focus = null;
  draw();
});
window.addEventListener("keydown", (e) => {
  state.events.push("key " + e.key + (e.ctrlKey ? " ctrl" : ""));
  if (e.key === "Enter") return submit();
  if (e.key === "Tab") { e.preventDefault(); state.focus = state.focus === "user" ? "pass" : "user"; return draw(); }
  if (!state.focus) return;
  if (e.key === "Backspace") state[state.focus] = state[state.focus].slice(0, -1);
  else if (e.key.length === 1) state[state.focus] += e.key;
  draw();
});
draw();
</script></body></html>`;

function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => resolve(new URLSearchParams(body)));
  });
}

export async function startOldSystem(options: { port?: number; host?: string } = {}): Promise<OldSystem> {
  const requests: OldSystem["requests"] = [];
  const orders: OldSystem["orders"] = new Map([
    ["PO-4711", { status: "Open", delivery: "02.10.2026", customer: "Anadolu Makina" }],
    ["PO-4712", { status: "Shipped", delivery: "28.09.2026", customer: "Ege Tekstil" }],
  ]);
  const sessions = new Set<string>();
  const html = (response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    response.end(body);
  };
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method ?? "GET", path: url.pathname });
    const cookie = /sid=([a-z0-9]+)/.exec(request.headers.cookie ?? "")?.[1];
    const signedIn = cookie !== undefined && sessions.has(cookie);
    if (url.pathname === "/desk") return html(response, 200, DESK);
    if (url.pathname === "/favicon.ico") return html(response, 404, "");
    if (url.pathname === "/" || url.pathname === "/login") {
      if (request.method === "POST") {
        const form = await readBody(request);
        if (form.get("user") === OLD_SYSTEM_USER && form.get("pass") === OLD_SYSTEM_PASSWORD) {
          const sid = Math.random().toString(36).slice(2);
          sessions.add(sid);
          return html(response, 302, "", { location: "/orders", "set-cookie": `sid=${sid}; Path=/` });
        }
        return html(response, 200, page("Sign in", `<p style="color:red">Wrong user or password.</p>${LOGIN_FORM}`));
      }
      return html(response, 200, page("Sign in", LOGIN_FORM));
    }
    if (!signedIn) return html(response, 302, "", { location: "/login" });
    if (url.pathname === "/orders") {
      const q = (url.searchParams.get("q") ?? "").trim().toUpperCase();
      const rows = [...orders.entries()]
        .filter(([id]) => !q || id.includes(q))
        .map(([id, o]) => `<tr><td><a href="/orders/${id}">${id}</a></td><td>${o.customer}</td><td>${o.status}</td></tr>`)
        .join("");
      return html(
        response,
        200,
        page(
          "Orders",
          `<form method="get" action="/orders"><table><tr><td>Order no:</td><td><input name="q" value="${q}"></td><td><input type="submit" value="Search"></td></tr></table></form>
          <table border="1"><tr><th>Order</th><th>Customer</th><th>Status</th></tr>${rows}</table>
          <p><a href="/orders/PO-4712" target="_blank">Open PO-4712 in a new window</a> · <a href="http://evil.example/steal">Partner portal</a> · <a href="/frames">Classic view</a></p>
          <p class="status">Signed in as ${OLD_SYSTEM_USER}</p>`,
        ),
      );
    }
    const detail = /^\/orders\/(PO-\d+)(\/status)?$/.exec(url.pathname);
    if (detail) {
      const id = detail[1]!;
      const order = orders.get(id);
      if (!order) return html(response, 404, page("Not found", `<p>No order ${id}.</p>`));
      if (detail[2] && request.method === "POST") {
        const form = await readBody(request);
        order.status = form.get("status") ?? order.status;
        return html(response, 302, "", { location: `/orders/${id}?saved=1` });
      }
      const options = ["Open", "Shipped", "Delivered"].map((s) => `<option${s === order.status ? " selected" : ""}>${s}</option>`).join("");
      return html(
        response,
        200,
        page(
          `Order ${id}`,
          `<h2>Order ${id}</h2>${url.searchParams.get("saved") ? "<p><b>Saved.</b></p>" : ""}
          <table><tr><td>Customer:</td><td>${order.customer}</td></tr><tr><td>Status:</td><td id="status">${order.status}</td></tr><tr><td>Delivery date:</td><td>${order.delivery}</td></tr></table>
          <form method="post" action="/orders/${id}/status"><table><tr><td>New status:</td><td><select name="status">${options}</select></td>
          <td><input type="submit" value="Save" onclick="return confirm('Change the status of ${id}?')"></td></tr></table></form>
          <p><a href="/orders">Back to orders</a></p>`,
        ),
      );
    }
    if (url.pathname === "/frames") {
      return html(
        response,
        200,
        `<!doctype html><html><head><title>Classic view</title></head><frameset cols="200,*"><frame name="menu" src="/frames/menu"><frame name="main" src="/orders/PO-4711"></frameset></html>`,
      );
    }
    if (url.pathname === "/frames/menu")
      return html(
        response,
        200,
        `<html><body><a href="/orders" target="main">All orders</a><br><span onclick="alert('Reports are closed')">Reports</span></body></html>`,
      );
    return html(response, 404, page("Not found", "<p>Not found.</p>"));
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    requests,
    orders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const LOGIN_FORM = `<form method="post" action="/login"><table>
<tr><td>User name:</td><td><input name="user"></td></tr>
<tr><td>Password:</td><td><input type="password" name="pass"></td></tr>
<tr><td></td><td><input type="submit" value="Sign in"></td></tr></table></form>`;

// `pnpm --filter @enterprise-brain/screens demo`: the order system on http://localhost:3300 (PORT to change it).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const system = await startOldSystem({ port: Number(process.env.PORT) || 3300, host: process.env.HOST || "127.0.0.1" });
  console.log(`ACME Order System on ${system.url}/login (user ${OLD_SYSTEM_USER}, password ${OLD_SYSTEM_PASSWORD}); a desktop program in ${system.url}/desk`);
}
