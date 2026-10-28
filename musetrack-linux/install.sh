#!/usr/bin/env bash
set -e

echo "=== [1/4] Preparing Linux Host & Bun Runtime ==="
if ! command -v bun &> /dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

echo "=== [2/4] Installing Production Dependencies ==="
bun install

echo "=== [3/4] Initializing musetrack.sqlite with WAL mode ==="
bun run -e 'import { initDatabase } from "./src/db.ts"; initDatabase();'

echo "=== [4/4] Installation Complete ==="
echo "Run interactively:  bun start"
echo "Or start daemon:    sudo cp musetrack.service /etc/systemd/system/ && sudo systemctl enable --now musetrack"