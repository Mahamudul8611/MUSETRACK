# MUSETRACK

> Ultra-lightweight Task Scheduler, Device Fleet Manager, and Meta Muse AI Node Agent built with Bun, Hono, and SQLite.

[![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Framework](https://img.shields.io/badge/Framework-Hono-orange?logo=hono)](https://hono.dev)
[![Database](https://img.shields.io/badge/Storage-SQLite_(WAL)-blue?logo=sqlite)](https://sqlite.org)

---

## Available Editions

This repository provides two purpose-built editions:

### 1. `musetrack-linux` (Linux & Raspberry Pi Edition)
Optimized for headless SBCs (Raspberry Pi Zero, 3, 4, 5) and Linux servers.
- **Hardware Telemetry:** Direct monitoring of Pi SoC temperatures (`vcgencmd`), undervoltage/throttling status, and `/proc/meminfo`.
- **Fleet Pull-Agent:** Includes `node-agent.ts` to execute tasks on remote nodes behind NAT without opening inbound ports.
- **Daemon Setup:** Comes with pre-configured `musetrack.service` systemd unit and automated `install.sh`.

### 2. `musetrack-core` (Universal / Pure Code Edition)
Platform-agnostic engine designed to run anywhere with zero system dependencies.
- **Runs Everywhere:** Native support for Windows, macOS, Linux containers, and Termux.
- **Abstracted Platform Layer:** Standardized OS metrics, decoupled UI, and sandbox command handler.
- **Integration Ready:** Can be embedded as a background service or paired with custom web/CLI interfaces.

---

## Quick Start

### Prerequisites
- [Bun runtime](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash` or `powershell -c "irm bun.sh/install.ps1 | iex"`)

### Installation & Run

```bash
# Clone the repository
git clone [https://github.com/YOUR-USERNAME/musetrack.git](https://github.com/YOUR-USERNAME/musetrack.git)
cd musetrack

# Choose your edition
cd musetrack-linux  # or cd musetrack-core

# Install dependencies and start
bun install
bun start
