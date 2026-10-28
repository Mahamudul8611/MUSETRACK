import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "./db";

const execFileAsync = promisify(execFile);

/**
 * Muse connectivity — how it actually works (v2.1)
 * --------------------------------------------------
 * Two different things are both called "Muse", keep them apart:
 * (1) Muse the personal assistant (the Muse app) reaches MuseTrack from
 *     the OUTSIDE, through MuseTrack's token-protected Agent API (see
 *     GET /api/agent/manifest in index.ts).
 * (2) Muse the MODEL can also live INSIDE the app, via Meta's developer
 *     Model API — that is provider "meta" below. It is a separate,
 *     pay-as-you-go developer service (dev.meta.ai), not the app subscription.
 * MuseTrack's built-in chat box is pluggable:
 *
 *   provider "ollama"  (DEFAULT) — your local model on the Pi/laptop.
 *                      Private, offline, free. Defaults match Mahamudul's Pi:
 *                      llama3.2:3b, with qwen2.5:1.5b as the fast option.
 *   provider "meta"    — REAL Muse, in-app: the Meta Model API
 *                      (https://api.meta.ai/v1, OpenAI-compatible). Get a key at
 *                      https://dev.meta.ai → API keys (shown once), set
 *                      MODEL_API_KEY in .env. Pay-as-you-go, billing required —
 *                      it is NOT covered by a Muse app subscription.
 *                      Supports tool calling: Muse can read node state and
 *                      create tasks/reminders through the tools in index.ts.
 *   provider "openai"  — any other OpenAI-compatible endpoint (OpenAI,
 *                      OpenRouter — incl. meta/muse-wonder — Groq, LM Studio).
 *   provider "offline" — no model at all: answers from live local state
 *                      (telemetry + tasks + devices). Always works.
 *
 * v1 silently sent every prompt to text.pollinations.ai (a third-party free
 * proxy) while labelling it "Meta Muse AI", and hardcoded a single
 * SUV-vs-sedan answer as its offline fallback. Both are removed.
 */

export type AiProvider = "ollama" | "meta" | "openai" | "offline";

/** The node-side tools a cloud model may call (implemented in index.ts). */
export type ToolHandler = (name: string, args: any) => Promise<string>;

export const MUSE_TOOLS = [
  { type: "function", function: { name: "get_node_status", description: "Get this node's live telemetry: temperature, load, RAM, disk, uptime.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "list_open_tasks", description: "List this node's open (not completed) tasks.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "create_task", description: "Create a task on this node.", parameters: { type: "object", properties: { title: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high", "critical"] }, target_device: { type: "string", description: "Hostname of the fleet node this task is for; omit for this node." } }, required: ["title"] } } },
  { type: "function", function: { name: "add_reminder", description: "Add a reminder on this node.", parameters: { type: "object", properties: { title: { type: "string" }, due_at: { type: "string", description: "ISO 8601 datetime, e.g. 2026-10-28T09:00:00" } }, required: ["title"] } } },
  { type: "function", function: { name: "list_devices", description: "List the registered fleet devices and their online status.", parameters: { type: "object", properties: {} } } },
];

export interface MuseTaskPayload {
  prompt: string;
  target_device?: string;
  aiProvider?: AiProvider;
  model?: string;
}

export interface NodeContext {
  telemetryLine: string;
  openTasks: string[];
  devices: string[];
}

const ALLOW_ARBITRARY_SHELL = () => process.env.ALLOW_ARBITRARY_SHELL === "1";
const TIMEOUT = () => parseInt(process.env.AI_TIMEOUT_MS || "60000", 10);

/** Fixed allowlist of read-only system intents. No shell strings anywhere. */
const INTENTS: Array<{ test: RegExp; argv: string[]; label: string }> = [
  { test: /disk space|disk usage/, argv: ["df", "-h", "/"], label: "disk space" },
  { test: /memory usage|ram usage/, argv: ["free", "-m"], label: "memory usage" },
  { test: /network info|ip address/, argv: ["hostname", "-I"], label: "network info" },
  { test: /list files/, argv: ["ls", "-la"], label: "list files" },
  { test: /whoami/, argv: ["whoami"], label: "whoami" },
  { test: /uptime/, argv: ["uptime"], label: "uptime" },
  { test: /temperature|temp\b/, argv: ["vcgencmd", "measure_temp"], label: "temperature" },
];

export class MuseAIConnector {
  detectIntent(prompt: string) {
    const p = prompt.toLowerCase();
    return INTENTS.find((i) => i.test.test(p)) || null;
  }

  isArbitraryShell(prompt: string) {
    return /^(run|exec)\s+/i.test(prompt.trim());
  }

  async dispatch(payload: MuseTaskPayload, ctx: NodeContext, toolHandler?: ToolHandler) {
    const prompt = (payload.prompt || "").trim();
    if (!prompt) return { type: "error", status: "error", answer: "Empty prompt." };

    // 1) Arbitrary shell — OFF by default, explicit opt-in + token auth (enforced in index.ts)
    if (this.isArbitraryShell(prompt)) {
      if (!ALLOW_ARBITRARY_SHELL()) {
        return {
          type: "automation", status: "blocked",
          answer: "Arbitrary shell execution is disabled on this node. Set ALLOW_ARBITRARY_SHELL=1 in .env (and a MUSETRACK_TOKEN) to enable 'run …' / 'exec …'. Read-only intents like 'disk space', 'memory usage', 'list files', 'uptime' work without it.",
        };
      }
      const cmd = prompt.replace(/^(run|exec)\s+/i, "");
      log("WARN", `Arbitrary shell via dispatch: ${cmd}`);
      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], { timeout: 15000, maxBuffer: 256 * 1024 });
        const output = (stdout + stderr).trim() || "Command executed with no output.";
        return { type: "automation", status: "executed", command: cmd, answer: `Executed: \`${cmd}\`\n\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\`` };
      } catch (err: any) {
        return { type: "automation", status: "error", command: cmd, answer: `Failed: ${err.message}` };
      }
    }

    // 2) Allowlisted read-only system intents — safe on any node, no shell parsing
    const intent = this.detectIntent(prompt);
    if (intent && process.platform !== "win32") {
      try {
        const { stdout, stderr } = await execFileAsync(intent.argv[0], intent.argv.slice(1), { timeout: 8000, maxBuffer: 256 * 1024 });
        const output = (stdout + stderr).trim() || "No output.";
        return { type: "automation", status: "executed", command: intent.argv.join(" "), answer: `**${intent.label}** (\`${intent.argv.join(" ")}\`)\n\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\`` };
      } catch (err: any) {
        return { type: "automation", status: "error", answer: `Could not run ${intent.label}: ${err.message}` };
      }
    }

    // 3) Model providers
    const provider: AiProvider = payload.aiProvider || (process.env.AI_PROVIDER as AiProvider) || "ollama";
    if (provider === "meta") {
      const r = await this.askMeta(prompt, payload.model, ctx, toolHandler);
      if (r) return r;
      return { type: "ai_response", status: "completed", provider: "offline", answer: `Meta Model API (api.meta.ai) is not reachable from this node right now, so here is the live local answer instead:\n\n${this.offlineAnswer(prompt, ctx)}` };
    }
    if (provider === "ollama") {
      const r = await this.askOllama(prompt, payload.model, ctx);
      if (r) return r;
      // fall through to offline with a note — never silently ship the prompt to a third party
      return { type: "ai_response", status: "completed", provider: "offline", answer: `Local model (Ollama) is not reachable, so here is the live local answer instead:\n\n${this.offlineAnswer(prompt, ctx)}` };
    }
    if (provider === "openai") {
      const r = await this.askOpenAICompatible(prompt, payload.model, ctx);
      if (r) return r;
      return { type: "ai_response", status: "completed", provider: "offline", answer: `OpenAI-compatible provider is not configured/reachable (set OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL). Live local answer:\n\n${this.offlineAnswer(prompt, ctx)}` };
    }
    return { type: "ai_response", status: "completed", provider: "offline", answer: this.offlineAnswer(prompt, ctx) };
  }

  private systemPrompt(ctx: NodeContext, withTools = false) {
    return [
      "You are Muse, the AI inside MuseTrack — a lightweight node manager running on the user's own Linux laptop / Raspberry Pi.",
      "Answer concisely and directly. Use the live node context below when it is relevant; do not invent device or task state that is not in it.",
      ...(withTools ? ["You have tools that act on THIS node (get_node_status, list_open_tasks, create_task, add_reminder, list_devices). When the user asks you to do one of those things, call the tool, then briefly confirm what you actually did."] : []),
      `Node: ${ctx.telemetryLine}`,
      `Open tasks: ${ctx.openTasks.length ? ctx.openTasks.join(" | ") : "none"}`,
      `Fleet: ${ctx.devices.length ? ctx.devices.join(" | ") : "no other devices registered"}`,
    ].join("\n");
  }

  /**
   * REAL Muse inside the app — Meta Model API (OpenAI-compatible).
   * Key: MODEL_API_KEY (Meta's name) or META_API_KEY, from https://dev.meta.ai
   * → API keys. Model: META_MODEL, default muse-spark-1.3 (muse-wonder-1.0
   * also works). Runs up to 3 tool-calling rounds against the node's tools.
   */
  private async askMeta(prompt: string, modelOverride: string | undefined, ctx: NodeContext, toolHandler?: ToolHandler) {
    const base = (process.env.META_API_BASE || "https://api.meta.ai/v1").replace(/\/$/, "");
    const key = process.env.MODEL_API_KEY || process.env.META_API_KEY || "";
    const model = modelOverride || process.env.META_MODEL || "muse-spark-1.3";
    if (!key) {
      return {
        type: "ai_response", status: "error", provider: "meta", model,
        answer: "Meta Muse API is selected, but no API key is set on this node yet.\n\nTo connect Muse:\n1. Go to https://dev.meta.ai and create a (free) developer account.\n2. Add billing — the Model API is pay-as-you-go, there is no free tier, and it is separate from any Muse app subscription.\n3. API keys → Create API key, and copy it immediately (it is shown only once).\n4. Put it in MuseTrack's .env as MODEL_API_KEY=<key> and restart MuseTrack.\nThe key stays on this node only — it is never entered in the web UI.",
      };
    }
    const messages: any[] = [
      { role: "system", content: this.systemPrompt(ctx, !!toolHandler) },
      { role: "user", content: prompt },
    ];
    try {
      for (let round = 0; round < 3; round++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT());
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages, ...(toolHandler ? { tools: MUSE_TOOLS, tool_choice: "auto" } : {}) }),
        });
        clearTimeout(t);
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          return {
            type: "ai_response", status: "error", provider: "meta", model,
            answer: `Meta Model API returned HTTP ${res.status}. ${detail}\nCheck: MODEL_API_KEY is valid (keys are shown once at creation — if lost, revoke and make a new one at dev.meta.ai), billing is set up on the team, and META_MODEL ('${model}') exists. Nothing was sent anywhere else.`,
          };
        }
        const data: any = await res.json();
        const msg = data?.choices?.[0]?.message;
        const calls = msg?.tool_calls;
        if (calls?.length && toolHandler) {
          messages.push(msg);
          for (const call of calls) {
            let args: any = {};
            try { args = JSON.parse(call?.function?.arguments || "{}"); } catch {}
            let result: string;
            try { result = await toolHandler(call.function.name, args); }
            catch (e: any) { result = `ERROR: ${e.message}`; }
            log("INFO", `Meta Muse tool call: ${call.function.name} -> ${String(result).slice(0, 120)}`);
            messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 2000) });
          }
          continue;
        }
        const answer = msg?.content?.trim();
        return answer ? { type: "ai_response", status: "completed", provider: "meta", model, answer, ...(data.usage ? { usage: data.usage } : {}) } : null;
      }
      return { type: "ai_response", status: "error", provider: "meta", model, answer: "Muse kept requesting tools after 3 rounds, so I stopped to avoid a loop. Try a more specific prompt." };
    } catch { return null; } // network-level failure -> offline fallback in dispatch()
  }

  private async askOllama(prompt: string, modelOverride: string | undefined, ctx: NodeContext) {
    const base = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = modelOverride || process.env.OLLAMA_MODEL || "llama3.2:3b";
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT());
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model, stream: false,
          messages: [
            { role: "system", content: this.systemPrompt(ctx) },
            { role: "user", content: prompt },
          ],
        }),
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const data: any = await res.json();
      const answer = data?.message?.content?.trim();
      return answer ? { type: "ai_response", status: "completed", provider: "ollama", model, answer } : null;
    } catch { return null; }
  }

  private async askOpenAICompatible(prompt: string, modelOverride: string | undefined, ctx: NodeContext) {
    const base = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
    const key = process.env.OPENAI_API_KEY || "";
    const model = modelOverride || process.env.OPENAI_MODEL || "";
    if (!base || !model) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT());
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: this.systemPrompt(ctx) },
            { role: "user", content: prompt },
          ],
        }),
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const data: any = await res.json();
      const answer = data?.choices?.[0]?.message?.content?.trim();
      return answer ? { type: "ai_response", status: "completed", provider: "openai", model, answer } : null;
    } catch { return null; }
  }

  /** Useful with zero models installed: answers from the node's real state. */
  offlineAnswer(prompt: string, ctx: NodeContext): string {
    const p = prompt.toLowerCase();
    if (p.includes("task") || p.includes("todo") || p.includes("pending")) {
      return ctx.openTasks.length
        ? `Open tasks on this node:\n${ctx.openTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
        : "No open tasks on this node right now.";
    }
    if (p.includes("device") || p.includes("fleet") || p.includes("online")) {
      return ctx.devices.length ? `Fleet:\n${ctx.devices.map((d) => `• ${d}`).join("\n")}` : "No other devices registered yet.";
    }
    if (p.includes("status") || p.includes("health") || p.includes("how are you")) return `Node status — ${ctx.telemetryLine}`;
    return `Offline mode (no model reached). Live node state: ${ctx.telemetryLine}\nOpen tasks: ${ctx.openTasks.length}. Ask about "tasks", "devices" or "status", or start Ollama for full AI answers.`;
  }
}

export const museClient = new MuseAIConnector();
