/**
 * MuseTrack node agent — run this on a small node (Pi Zero, old laptop) that
 * should RECEIVE work from a master MuseTrack instead of serving the UI.
 *
 *   MASTER_URL=http://192.168.1.10:3000 MUSETRACK_TOKEN=xxx NODE_NAME=pi-zero-2 bun run node-agent.ts
 *
 * It heartbeats to the master (so it appears under Devices), polls the pull-queue
 * for tasks targeted at NODE_NAME, claims them, executes them, and posts the
 * result back. Execution rules mirror the scheduler:
 *   "shell: <cmd>"  -> sh -c        "muse: <prompt>" or plain -> this node's local
 *   MuseTrack dispatch if one is running on localhost:3000, otherwise the prompt
 *   is answered with the node's hostname/uptime only if it is a safe intent.
 * Polling (pull) means the node needs NO open inbound ports — works behind NAT.
 */
const MASTER = (process.env.MASTER_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.MUSETRACK_TOKEN || "";
const NAME = process.env.NODE_NAME || require("os").hostname();
const POLL_MS = parseInt(process.env.AGENT_POLL_MS || "15000", 10);
const LOCAL = (process.env.LOCAL_MUSETRACK || "http://127.0.0.1:3000").replace(/\/$/, "");

const headers = { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

async function myIp(): Promise<string> {
  try {
    const nets = require("os").networkInterfaces();
    for (const list of Object.values(nets)) for (const n of list as any[]) if (n.family === "IPv4" && !n.internal) return n.address;
  } catch {}
  return "unknown";
}

async function execTask(title: string): Promise<string> {
  if (title.startsWith("shell:")) {
    const cmd = title.slice(6).trim();
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    return out.trim().slice(0, 4000) || "OK";
  }
  const prompt = title.startsWith("muse:") ? title.slice(5).trim() : title;
  try {
    const res = await fetch(`${LOCAL}/api/muse/dispatch`, { method: "POST", headers, body: JSON.stringify({ prompt }) });
    if (res.ok) { const d: any = await res.json(); return String(d.answer || d.status).slice(0, 4000); }
  } catch {}
  return `Node ${NAME}: no local MuseTrack/Ollama reachable to answer "${prompt}". Start MuseTrack on this node or prefix the task with "shell:".`;
}

async function loop() {
  try {
    await fetch(`${MASTER}/api/agent/heartbeat`, { method: "POST", headers, body: JSON.stringify({ hostname: NAME, ip_address: await myIp(), device_type: "sbc" }) });
    const q = await fetch(`${MASTER}/api/agent/queue?device=${encodeURIComponent(NAME)}`, { headers });
    if (!q.ok) { console.log(`[agent] queue fetch: HTTP ${q.status}`); return; }
    const tasks: any[] = await q.json();
    for (const t of tasks) {
      const claim = await fetch(`${MASTER}/api/agent/claim/${t.id}`, { method: "POST", headers });
      if (!claim.ok) continue;
      console.log(`[agent] running task #${t.id}: ${t.title}`);
      let result = "", status = "complete";
      try { result = await execTask(t.title); } catch (e: any) { result = `ERROR: ${e.message}`; }
      await fetch(`${MASTER}/api/agent/result/${t.id}`, { method: "POST", headers, body: JSON.stringify({ status, result }) });
    }
  } catch (e: any) { console.log(`[agent] ${e.message}`); }
}

console.log(`[agent] ${NAME} -> master ${MASTER}, polling every ${POLL_MS}ms`);
loop();
setInterval(loop, POLL_MS);
