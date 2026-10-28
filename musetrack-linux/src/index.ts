import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { timingSafeEqual } from "crypto";
import os from "os";
import { db, initDatabase, log } from "./db";
import { getSystemTelemetry, pingHost } from "./system";
import { museClient, type NodeContext } from "./muse";
import { startScheduler, runSchedule, isValidCron } from "./scheduler";

initDatabase();

const app = new Hono();
const VERSION = "2.1.0";
const NODE_NAME = process.env.NODE_NAME || os.hostname();
const TOKEN = process.env.MUSETRACK_TOKEN || "";

// ---------- helpers ----------
async function body(c: any): Promise<any> {
  try { return await c.req.json(); } catch { return {}; }
}
function tokenOk(given: string): boolean {
  if (!TOKEN) return true;
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
const STATUSES = ["pending", "progress", "complete"];
const PRIORITIES = ["low", "medium", "high", "critical"];

async function nodeContext(): Promise<NodeContext> {
  const t = await getSystemTelemetry();
  const tasks = db.query("SELECT title, status, priority FROM tasks WHERE status != 'complete' ORDER BY id DESC LIMIT 10").all() as any[];
  const devices = db.query("SELECT hostname, ip_address, status FROM devices ORDER BY id ASC").all() as any[];
  return {
    telemetryLine: `${NODE_NAME} (${t.piModel || t.arch}, ${t.os}) temp ${t.temperature}, RAM ${t.systemRam}, load ${t.loadAverage.join("/")}, disk ${t.disk ? `${t.disk.freeGb}GB free` : "n/a"}`,
    openTasks: tasks.map((x) => `[${x.status}/${x.priority}] ${x.title}`),
    devices: devices.map((x) => `${x.hostname} ${x.ip_address} ${x.status}`),
  };
}

// ---------- CORS + auth ----------
// CORS stays open for the local UI (same origin), but when a token is set it is
// required on every /api route except /api/health. A Pi reachable from the
// internet or a shared LAN must set MUSETRACK_TOKEN — dispatch can run commands.
app.use("*", cors());
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  if (!TOKEN) return next();
  const auth = c.req.header("Authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : (c.req.header("X-API-Key") || "");
  if (!tokenOk(given)) return c.json({ error: "unauthorized — send Authorization: Bearer <MUSETRACK_TOKEN>" }, 401);
  return next();
});
app.onError((err, c) => { log("ERROR", `${c.req.method} ${c.req.path}: ${err.message}`); return c.json({ error: err.message }, 500); });
app.notFound((c) => c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("Not found", 404));

// ---------- health / telemetry ----------
app.get("/api/health", async (c) => c.json({ ok: true, app: "musetrack", version: VERSION, node: NODE_NAME, authRequired: !!TOKEN, time: new Date().toISOString() }));
app.get("/api/system/status", async (c) => c.json({ status: "online", version: VERSION, ...(await getSystemTelemetry()) }));

// ---------- tasks ----------
app.get("/api/tasks", (c) => {
  const status = c.req.query("status");
  const device = c.req.query("target_device");
  let q = "SELECT * FROM tasks WHERE 1=1";
  const params: any[] = [];
  if (status) { q += " AND status = ?"; params.push(status); }
  if (device) { q += " AND target_device = ?"; params.push(device); }
  q += " ORDER BY id DESC LIMIT 500";
  return c.json(db.query(q).all(...params));
});

app.post("/api/tasks", async (c) => {
  const b = await body(c);
  if (!b.title?.trim()) return c.json({ error: "title is required" }, 400);
  if (b.status && !STATUSES.includes(b.status)) return c.json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
  if (b.priority && !PRIORITIES.includes(b.priority)) return c.json({ error: `priority must be one of ${PRIORITIES.join(", ")}` }, 400);
  const res = db.run(
    "INSERT INTO tasks (title, description, priority, target_device, status, result, project_id, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [b.title.trim(), b.description || "", b.priority || "medium", b.target_device || "localhost", b.status || "pending", b.result || "", b.project_id ?? null, b.due_at ?? null]
  );
  return c.json({ success: true, id: res.lastInsertRowid }, 201);
});

app.patch("/api/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const b = await body(c);
  const fields: string[] = [], params: any[] = [];
  for (const k of ["title", "description", "result", "target_device", "due_at"]) if (k in b) { fields.push(`${k} = ?`); params.push(b[k]); }
  if ("status" in b) { if (!STATUSES.includes(b.status)) return c.json({ error: "invalid status" }, 400); fields.push("status = ?"); params.push(b.status); }
  if ("priority" in b) { if (!PRIORITIES.includes(b.priority)) return c.json({ error: "invalid priority" }, 400); fields.push("priority = ?"); params.push(b.priority); }
  if (!fields.length) return c.json({ error: "nothing to update" }, 400);
  const r = db.run(`UPDATE tasks SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...params, id]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "task not found" }, 404);
});

app.delete("/api/tasks/:id", (c) => {
  const r = db.run("DELETE FROM tasks WHERE id = ?", [c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "task not found" }, 404);
});

// ---------- reminders ----------
app.get("/api/reminders", (c) => c.json(db.query("SELECT * FROM reminders ORDER BY due_at ASC").all()));
app.post("/api/reminders", async (c) => {
  const b = await body(c);
  if (!b.title?.trim()) return c.json({ error: "title is required" }, 400);
  const res = db.run("INSERT INTO reminders (title, due_at) VALUES (?, ?)", [b.title.trim(), b.due_at || new Date().toISOString()]);
  return c.json({ success: true, id: res.lastInsertRowid }, 201);
});
app.patch("/api/reminders/:id", async (c) => {
  const b = await body(c);
  const r = db.run("UPDATE reminders SET is_done = ?, notified_at = CASE WHEN ? = 0 THEN NULL ELSE notified_at END WHERE id = ?",
    [b.is_done ? 1 : 0, b.is_done ? 1 : 0, c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "reminder not found" }, 404);
});
app.delete("/api/reminders/:id", (c) => {
  const r = db.run("DELETE FROM reminders WHERE id = ?", [c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "reminder not found" }, 404);
});

// ---------- projects ----------
app.get("/api/projects", (c) => c.json(db.query("SELECT * FROM projects ORDER BY id DESC").all()));
app.post("/api/projects", async (c) => {
  const b = await body(c);
  if (!b.name?.trim()) return c.json({ error: "name is required" }, 400);
  try {
    const res = db.run("INSERT INTO projects (name, description) VALUES (?, ?)", [b.name.trim(), b.description || ""]);
    return c.json({ success: true, id: res.lastInsertRowid }, 201);
  } catch { return c.json({ error: "project name already exists" }, 409); }
});
app.delete("/api/projects/:id", (c) => {
  const r = db.run("DELETE FROM projects WHERE id = ?", [c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "project not found" }, 404);
});

// ---------- schedules (now actually executed — see scheduler.ts) ----------
app.get("/api/schedules", (c) => c.json(db.query("SELECT * FROM schedules ORDER BY id DESC").all()));
app.post("/api/schedules", async (c) => {
  const b = await body(c);
  if (!b.name?.trim() || !b.command?.trim()) return c.json({ error: "name and command are required" }, 400);
  if (!isValidCron(b.cron_pattern || "")) return c.json({ error: "cron_pattern must be 5 fields, e.g. '0 8 * * *'" }, 400);
  const res = db.run("INSERT INTO schedules (name, cron_pattern, command) VALUES (?, ?, ?)", [b.name.trim(), b.cron_pattern.trim(), b.command.trim()]);
  return c.json({ success: true, id: res.lastInsertRowid }, 201);
});
app.patch("/api/schedules/:id", async (c) => {
  const b = await body(c);
  if ("cron_pattern" in b && !isValidCron(b.cron_pattern)) return c.json({ error: "invalid cron_pattern" }, 400);
  const fields: string[] = [], params: any[] = [];
  for (const k of ["name", "cron_pattern", "command"]) if (k in b) { fields.push(`${k} = ?`); params.push(b[k]); }
  if ("is_active" in b) { fields.push("is_active = ?"); params.push(b.is_active ? 1 : 0); }
  if (!fields.length) return c.json({ error: "nothing to update" }, 400);
  const r = db.run(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`, [...params, c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "schedule not found" }, 404);
});
app.delete("/api/schedules/:id", (c) => {
  const r = db.run("DELETE FROM schedules WHERE id = ?", [c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "schedule not found" }, 404);
});
app.post("/api/schedules/:id/run", async (c) => {
  const s = db.query("SELECT * FROM schedules WHERE id = ?").get(c.req.param("id")) as any;
  if (!s) return c.json({ error: "schedule not found" }, 404);
  const result = await runSchedule(s, nodeContext);
  return c.json({ success: true, result });
});

// ---------- devices / fleet ----------
app.get("/api/devices", (c) => c.json(db.query("SELECT * FROM devices ORDER BY id ASC").all()));
app.post("/api/devices", async (c) => {
  const b = await body(c);
  if (!b.hostname?.trim() || !b.ip_address?.trim()) return c.json({ error: "hostname and ip_address are required" }, 400);
  try {
    const res = db.run("INSERT INTO devices (hostname, ip_address, device_type, status) VALUES (?, ?, ?, 'offline')",
      [b.hostname.trim(), b.ip_address.trim(), b.device_type || "raspberry-pi"]);
    return c.json({ success: true, id: res.lastInsertRowid }, 201);
  } catch { return c.json({ error: "hostname already registered" }, 409); }
});
app.delete("/api/devices/:id", (c) => {
  const r = db.run("DELETE FROM devices WHERE id = ?", [c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "device not found" }, 404);
});
app.post("/api/devices/ping", async (c) => {
  const b = await body(c);
  const online = await pingHost(String(b.ip_address || ""));
  db.run("UPDATE devices SET status = ?, last_ping = CURRENT_TIMESTAMP, last_seen = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_seen END WHERE id = ?",
    [online ? "online" : "offline", online ? 1 : 0, b.id]);
  return c.json({ id: b.id, status: online ? "online" : "offline" });
});
app.post("/api/devices/ping-all", async (c) => {
  const devices = db.query("SELECT * FROM devices").all() as any[];
  const out = [];
  for (const d of devices) {
    const online = await pingHost(d.ip_address);
    db.run("UPDATE devices SET status = ?, last_ping = CURRENT_TIMESTAMP, last_seen = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_seen END WHERE id = ?",
      [online ? "online" : "offline", online ? 1 : 0, d.id]);
    out.push({ id: d.id, hostname: d.hostname, status: online ? "online" : "offline" });
  }
  return c.json(out);
});

// ---------- logs (system_logs existed in your real DB but had no API in v1) ----------
app.get("/api/logs", (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  return c.json(db.query("SELECT * FROM system_logs ORDER BY id DESC LIMIT ?").all(limit));
});
app.delete("/api/logs", (c) => { db.run("DELETE FROM system_logs"); return c.json({ success: true }); });

// ---------- Muse dispatch ----------
// Tools the Meta Model API provider may call on THIS node (allowlisted,
// no shell). Only wired into dispatch — the scheduler deliberately does
// not get tool access, so a cron prompt can't create tasks unsupervised.
async function nodeToolHandler(name: string, args: any): Promise<string> {
  switch (name) {
    case "get_node_status": {
      const t = await getSystemTelemetry();
      return JSON.stringify({ node: NODE_NAME, temp: t.temperature, load: t.loadAverage, ram: t.systemRam, disk: t.disk, throttled: t.throttled, systemUptimeSeconds: t.systemUptimeSeconds });
    }
    case "list_open_tasks": {
      const rows = db.query("SELECT id, title, status, priority, target_device FROM tasks WHERE status != 'complete' ORDER BY id DESC LIMIT 25").all() as any[];
      return rows.length ? rows.map((r) => `#${r.id} [${r.status}/${r.priority}] ${r.title} (target: ${r.target_device})`).join("\n") : "No open tasks.";
    }
    case "create_task": {
      if (!args?.title?.trim()) throw new Error("title is required");
      const priority = ["low", "medium", "high", "critical"].includes(args.priority) ? args.priority : "medium";
      const r = db.run("INSERT INTO tasks (title, description, priority, target_device, status) VALUES (?, 'Created by Meta Muse via tool call', ?, ?, 'pending')",
        [String(args.title).trim().slice(0, 200), priority, String(args.target_device || "localhost")]);
      return `Created task #${r.lastInsertRowid}: "${args.title}" (priority ${priority}, target ${args.target_device || "localhost"})`;
    }
    case "add_reminder": {
      if (!args?.title?.trim()) throw new Error("title is required");
      const due = args.due_at && !isNaN(Date.parse(args.due_at)) ? new Date(args.due_at).toISOString() : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const r = db.run("INSERT INTO reminders (title, due_at) VALUES (?, ?)", [String(args.title).trim().slice(0, 200), due]);
      return `Added reminder #${r.lastInsertRowid}: "${args.title}" due ${due}`;
    }
    case "list_devices": {
      const rows = db.query("SELECT hostname, ip_address, device_type, status, last_seen FROM devices ORDER BY id ASC").all() as any[];
      return rows.length ? rows.map((r) => `${r.hostname} ${r.ip_address} ${r.device_type} ${r.status}${r.last_seen ? ` (last seen ${r.last_seen})` : ""}`).join("\n") : "No devices registered.";
    }
    default: throw new Error(`unknown tool '${name}'`);
  }
}

app.post("/api/muse/dispatch", async (c) => {
  const b = await body(c);
  if (!b.prompt?.trim()) return c.json({ error: "prompt is required" }, 400);

  // Fleet dispatch: a prompt aimed at ANOTHER node is queued as a task for that
  // node to pick up via /api/agent/queue — no inbound ports needed on Pi Zeros.
  const target = (b.target_device || "localhost").trim();
  const isRemote = target !== "localhost" && target !== NODE_NAME && target !== os.hostname();
  if (isRemote) {
    const known = db.query("SELECT id FROM devices WHERE hostname = ?").get(target);
    if (!known) return c.json({ error: `unknown target_device '${target}' — register it under Devices first` }, 400);
    const res = db.run("INSERT INTO tasks (title, description, priority, target_device, status) VALUES (?, ?, 'high', ?, 'pending')",
      [b.prompt.trim(), "Dispatched via Muse (queued for remote node)", target]);
    log("INFO", `Queued prompt for ${target}: ${b.prompt.slice(0, 80)}`);
    return c.json({ type: "queued", status: "queued", target_device: target, taskId: res.lastInsertRowid, answer: `Queued for ${target}. It will run when that node polls /api/agent/queue.` });
  }

  const response = await museClient.dispatch(b, await nodeContext(), nodeToolHandler);
  const res = db.run(
    "INSERT INTO tasks (title, description, priority, target_device, status, result) VALUES (?, ?, 'high', 'localhost', 'complete', ?)",
    [b.prompt.trim().slice(0, 200), `Source: Muse (${response.type}${(response as any).provider ? "/" + (response as any).provider : ""})`, String((response as any).answer || "")]
  );
  return c.json({ ...response, taskId: res.lastInsertRowid });
});

// ---------- Agent API: how Muse (and other agents) drive this node ----------
app.get("/api/agent/manifest", async (c) => {
  const t = await getSystemTelemetry();
  return c.json({
    app: "musetrack", version: VERSION, node: NODE_NAME,
    device: { hostname: t.hostname, arch: t.arch, os: t.os, piModel: t.piModel },
    auth: TOKEN ? "bearer (MUSETRACK_TOKEN)" : "none set — set MUSETRACK_TOKEN before exposing this port",
    ai: {
      defaultProvider: process.env.AI_PROVIDER || "ollama",
      ollamaModel: process.env.OLLAMA_MODEL || "llama3.2:3b",
      metaModelApi: {
        configured: !!(process.env.MODEL_API_KEY || process.env.META_API_KEY),
        model: process.env.META_MODEL || "muse-spark-1.3",
        base: process.env.META_API_BASE || "https://api.meta.ai/v1",
        toolCalling: true,
        getKey: "https://dev.meta.ai → API keys (pay-as-you-go, separate from the Muse app subscription)",
      },
      arbitraryShell: process.env.ALLOW_ARBITRARY_SHELL === "1",
    },
    capabilities: ["tasks", "reminders", "projects", "schedules (real cron engine)", "device fleet ping", "telemetry", "muse dispatch (local intents + model)", "agent pull-queue for remote nodes"],
    endpoints: {
      health: "GET /api/health", telemetry: "GET /api/system/status",
      tasks: "GET|POST /api/tasks, PATCH|DELETE /api/tasks/:id",
      dispatch: "POST /api/muse/dispatch {prompt, aiProvider?, target_device?}",
      queue: "GET /api/agent/queue?device=<hostname>",
      claim: "POST /api/agent/claim/:id", result: "POST /api/agent/result/:id {status, result}",
      schedules: "GET|POST /api/schedules, POST /api/schedules/:id/run",
      logs: "GET /api/logs",
    },
  });
});

// Pull-queue: remote nodes (Pi Zero etc.) poll for work assigned to them.
app.get("/api/agent/queue", (c) => {
  const device = c.req.query("device");
  if (!device) return c.json({ error: "device query param is required" }, 400);
  return c.json(db.query("SELECT * FROM tasks WHERE target_device = ? AND status = 'pending' ORDER BY id ASC LIMIT 20").all(device));
});
app.post("/api/agent/claim/:id", (c) => {
  const r = db.run("UPDATE tasks SET status = 'progress', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'", [c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "task not pending (already claimed/done?)" }, 409);
});
app.post("/api/agent/result/:id", async (c) => {
  const b = await body(c);
  const status = STATUSES.includes(b.status) ? b.status : "complete";
  const r = db.run("UPDATE tasks SET status = ?, result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, String(b.result || ""), c.req.param("id")]);
  return r.changes ? c.json({ success: true }) : c.json({ error: "task not found" }, 404);
});
app.post("/api/agent/heartbeat", async (c) => {
  const b = await body(c);
  if (!b.hostname) return c.json({ error: "hostname is required" }, 400);
  db.run(`INSERT INTO devices (hostname, ip_address, device_type, status, last_ping, last_seen)
          VALUES (?, ?, ?, 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(hostname) DO UPDATE SET ip_address = excluded.ip_address, status = 'online', last_ping = CURRENT_TIMESTAMP, last_seen = CURRENT_TIMESTAMP`,
    [b.hostname, b.ip_address || "unknown", b.device_type || "sbc"]);
  return c.json({ success: true });
});

// ---------- static UI ----------
app.use("/*", serveStatic({ root: "./public" }));

const PORT = parseInt(process.env.PORT || "3000", 10);
if (!TOKEN) log("WARN", "MUSETRACK_TOKEN is not set — anyone who can reach this port can use the API (including system intents). Fine on a private box, dangerous beyond it.");
log("INFO", `Core engine running on http://0.0.0.0:${PORT} (node: ${NODE_NAME})`);
startScheduler(nodeContext);

export default { port: PORT, fetch: app.fetch };
