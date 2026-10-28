import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface IPlatformTelemetry {
  platform: string;
  architecture: string;
  hostname: string;
  uptime: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  usedMemoryMb: number;
  cpuCount: number;
  cpuModel: string;
  processRssMb: number;
}

export class UniversalPlatformAdapter {
  static getTelemetry(): IPlatformTelemetry {
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    const cpus = os.cpus();

    return {
      platform: process.platform,
      architecture: process.arch,
      hostname: os.hostname(),
      uptime: Math.floor(os.uptime()),
      totalMemoryMb: totalMem,
      freeMemoryMb: freeMem,
      usedMemoryMb: totalMem - freeMem,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || "Unknown",
      processRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  }

  static async ping(targetHost: string): Promise<boolean> {
    const isWindows = process.platform === "win32";
    const cmd = isWindows
      ? `ping -n 1 -w 1000 ${targetHost}`
      : `ping -c 1 -W 1 ${targetHost}`;

    try {
      await execAsync(cmd);
      return true;
    } catch {
      return false;
    }
  }

  static executeSafeQuery(command: string): Promise<string> {
    // Pure code sandbox: Prevent raw arbitrary execution unless overridden
    return Promise.resolve(`Universal Sandbox: Command "${command}" queued.`);
  }
}