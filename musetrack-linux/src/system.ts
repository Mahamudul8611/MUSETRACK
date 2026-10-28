import { readFileSync, existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function getLinuxTelemetry() {
  let temperature = "N/A";
  let throttled = "0x0";

  // 1. Raspberry Pi VideoCore temperature & throttling check
  try {
    const { stdout: tempOut } = await execAsync("vcgencmd measure_temp");
    temperature = tempOut.replace("temp=", "").trim();

    const { stdout: throttleOut } = await execAsync("vcgencmd get_throttled");
    throttled = throttleOut.replace("throttled=", "").trim();
  } catch {
    // 2. Generic Linux thermal zone fallback
    if (existsSync("/sys/class/thermal/thermal_zone0/temp")) {
      try {
        const raw = readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf-8");
        temperature = `${(parseInt(raw.trim(), 10) / 1000).toFixed(1)} °C`;
      } catch {}
    }
  }

  // 3. Linux Kernel /proc/meminfo memory parsing
  let totalMem = 0;
  let availMem = 0;
  if (existsSync("/proc/meminfo")) {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf-8");
      const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (totalMatch) totalMem = Math.round(parseInt(totalMatch[1], 10) / 1024);
      if (availMatch) availMem = Math.round(parseInt(availMatch[1], 10) / 1024);
    } catch {}
  }

  const bunMem = Math.round(process.memoryUsage().rss / 1024 / 1024);

  return {
    os: "Linux",
    arch: process.arch,
    temperature,
    throttled,
    ram: totalMem ? `${totalMem - availMem}MB / ${totalMem}MB` : `${bunMem}MB (RSS)`,
    bunRss: `${bunMem}MB`,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export async function pingLinuxHost(ip: string): Promise<boolean> {
  try {
    await execAsync(`ping -c 1 -W 1 ${ip}`);
    return true;
  } catch {
    return false;
  }
}