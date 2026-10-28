import { execFile } from "child_process";
import { promisify } from "util";
import { db, log } from "./db";
import { museClient, type NodeContext } from "./muse";

const execFileAsync = promisify(execFile);

/**
 * A real scheduler for v1's dead `schedules` table.
 * - 5-field cron: minute hour day-of-month month day-of-week
 *   Supports:  *   * / n   a,b,c   a-b   (steps on ranges too: a-b/n)
 * - Command prefixes:
 *     muse: <prompt>   -> run through the Muse dispatcher (AI / safe intents)
 *     shell: <cmd>     -> run via sh -c (this is YOUR cron on YOUR box; creating
 *                         schedules is a token-protected API call when a token is set)
 *     anything else    -> treated as a muse: prompt
 * - Every run is written to schedules.last_run_at / last_result and system_logs,
 *   and due reminders are surfaced into system_logs on their minute.
 * No cron library — that's the whole point of the lightweight stack.
 */

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (range === "*") return value % step === 0;
    if (range.includes("-")) {
      const [a, b] = range.split("-").map((n) => parseInt(n, 10));
      return value >= a && value <= b && (value - a) % step === 0;
    }
    return parseInt(range, 10) === value;
  });
}

export function isValidCron(expr: string): boolean {
  const f = (expr || "").trim().split(/\s+/);
  if (f.length !== 5) return false;
  return f.every((part) => /^[\d*,\-\/]+$/.test(part));
}

export function cronMatches(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  // cron day-of-week: 0-7 (0 and 7 = Sunday); JS getDay(): 0 = Sunday
  return (
    fieldMatches(f[0], d.getMinutes()) &&
    fieldMatches(f[1], d.getHours()) &&
    fieldMatches(f[2], d.getDate()) &&
    fieldMatches(f[3], d.getMonth() + 1) &&
    (fieldMatches(f[4], d.getDay()) || (d.getDay() === 0 && fieldMatches(f[4], 7)))
  );
}

export async function runSchedule(s: any, ctx: () => Promise<NodeContext>): Promise<string> {
  const raw = String(s.command || "");
  let result: string;
  try {
    if (raw.startsWith("shell:")) {
      const cmd = raw.slice(6).trim();
      const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], { timeout: 30000, maxBuffer: 256 * 1024 });
      result = ((stdout + stderr).trim() || "OK").slice(0, 1500);
    } else {
      const prompt = raw.startsWith("muse:") ? raw.slice(5).trim() : raw;
      const r = await museClient.dispatch({ prompt }, await ctx());
      result = String(r.answer || r.status).slice(0, 1500);
    }
  } catch (err: any) {
    result = `ERROR: ${err.message}`;
  }
  db.run("UPDATE schedules SET last_run_at = CURRENT_TIMESTAMP, last_result = ? WHERE id = ?", [result, s.id]);
  log(result.startsWith("ERROR") ? "ERROR" : "INFO", `Schedule "${s.name}" ran: ${result.slice(0, 200)}`);
  return result;
}

let lastMinuteKey = "";

export function startScheduler(ctx: () => Promise<NodeContext>) {
  const tickMs = parseInt(process.env.SCHEDULER_TICK_MS || "20000", 10);
  const tick = async () => {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (minuteKey === lastMinuteKey) return; // act once per minute, however often we tick
    lastMinuteKey = minuteKey;

    const schedules = db.query("SELECT * FROM schedules WHERE is_active = 1").all() as any[];
    for (const s of schedules) {
      if (isValidCron(s.cron_pattern) && cronMatches(s.cron_pattern, now)) {
        runSchedule(s, ctx).catch((e) => log("ERROR", `Schedule ${s.id} failed: ${e.message}`));
      }
    }

    // Due reminders: log them once, on their minute
    const due = db.query(
      "SELECT * FROM reminders WHERE is_done = 0 AND notified_at IS NULL AND due_at <= datetime('now')"
    ).all() as any[];
    for (const r of due) {
      log("INFO", `⏰ Reminder due: ${r.title}`);
      db.run("UPDATE reminders SET notified_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
    }
  };
  const timer = setInterval(() => tick().catch(() => {}), tickMs);
  log("INFO", `Scheduler started (tick ${tickMs}ms — cron schedules + due reminders)`);
  return () => clearInterval(timer);
}
