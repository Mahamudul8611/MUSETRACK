import { readFileSync, existsSync, statfsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const execFileAsync = promisify(execFile);

async function piThrottle(): Promise<string | null> {
  // vcgencmd only exists on Raspberry Pi OS; get_throttled reveals under-voltage
  // / throttling, which is the #1 cause of "my Pi is randomly slow/corrupt".
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["get_throttled"], { timeout: 2000 });
    return stdout.trim(); // throttled=0x0 is healthy
  } catch { return null; }
}

function diskInfo() {
  try {
    // statfs is built into Node/Bun — no shelling out to `df` needed.
    const s: any = statfsSync("/");
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
    return { totalGb: gb(total), freeGb: gb(free), usedPct: Math.round(((total - free) / total) * 100) };
  } catch { return null; }
}

export async function getSystemTelemetry() {
  let temperature = "N/A";

  if (existsSync("/sys/class/thermal/thermal_zone0/temp")) {
    try {
      const raw = readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf-8");
      temperature = `${(parseInt(raw.trim(), 10) / 1000).toFixed(1)} °C`;
    } catch {}
  }
  if (temperature === "N/A") {
    try {
      const { stdout } = await execFileAsync("vcgencmd", ["measure_temp"], { timeout: 2000 });
      temperature = stdout.replace("temp=", "").trim();
    } catch { temperature = "N/A"; }
  }

  let piModel: string | null = null;
  if (existsSync("/proc/device-tree/model")) {
    try { piModel = readFileSync("/proc/device-tree/model", "utf-8").replace(/\0/g, "").trim(); } catch {}
  }

  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
  const usedMemMb = totalMemMb - freeMemMb;
  const bunMem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const load = os.loadavg().map((n) => Math.round(n * 100) / 100);

  return {
    hostname: os.hostname(),
    nodeName: process.env.NODE_NAME || os.hostname(),
    os: process.platform,
    arch: process.arch,
    piModel,
    temperature,
    throttled: await piThrottle(),
    cpuCount: os.cpus().length,
    loadAverage: load, // 1m / 5m / 15m
    bunRssMemMb: bunMem,
    systemRam: `${usedMemMb}MB / ${totalMemMb}MB (Bun: ${bunMem}MB)`,
    memUsedPct: totalMemMb ? Math.round((usedMemMb / totalMemMb) * 100) : 0,
    disk: diskInfo(),
    systemUptimeSeconds: Math.floor(os.uptime()),   // machine uptime (was: process uptime in v1)
    processUptimeSeconds: Math.floor(process.uptime()),
  };
}

const SAFE_HOST = /^[a-zA-Z0-9._:\-]+$/; // hostname, IPv4, or IPv6 literal — nothing shell-shaped

export async function pingHost(host: string): Promise<boolean> {
  // v1 interpolated the host into a shell string => `127.0.0.1; rm -rf ...` executed.
  // v2: validate the shape AND use execFile (argument array, no shell at all).
  if (!host || !SAFE_HOST.test(host) || host.startsWith("-")) return false;
  const isWindows = process.platform === "win32";
  const args = isWindows ? ["-n", "1", "-w", "1000", host] : ["-c", "1", "-W", "1", host];
  try {
    await execFileAsync("ping", args, { timeout: 3000 });
    return true;
  } catch { return false; }
}
