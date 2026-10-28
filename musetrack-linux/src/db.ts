import { Database } from "bun:sqlite";
import { resolve } from "path";

// DB file lives next to wherever you launch from; override with MUSETRACK_DB.
const dbPath = process.env.MUSETRACK_DB || resolve(process.cwd(), "musetrack.sqlite");
export const db = new Database(dbPath, { create: true });

// WAL + NORMAL is the right trade-off for SD cards: fast, low wear, crash-safe
// enough for a personal node. busy_timeout avoids "database is locked" when the
// scheduler and the API write at the same time.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      result TEXT,
      status TEXT CHECK(status IN ('pending', 'progress', 'complete')) DEFAULT 'pending',
      priority TEXT CHECK(priority IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      target_device TEXT DEFAULT 'localhost',
      due_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      due_at DATETIME NOT NULL,
      is_done INTEGER DEFAULT 0,
      notified_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cron_pattern TEXT NOT NULL,
      command TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      last_run_at DATETIME,
      last_result TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostname TEXT NOT NULL UNIQUE,
      ip_address TEXT NOT NULL,
      device_type TEXT DEFAULT 'sbc',
      status TEXT DEFAULT 'offline',
      last_ping DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'INFO',
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_target ON tasks(target_device, status);
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, is_done);
  `);

  // Safe upgrades for databases created by v1 (no more blind ALTER in try/catch)
  addColumnIfMissing("tasks", "result", "result TEXT");
  addColumnIfMissing("tasks", "due_at", "due_at DATETIME");
  addColumnIfMissing("reminders", "notified_at", "notified_at DATETIME");
  addColumnIfMissing("schedules", "last_run_at", "last_run_at DATETIME");
  addColumnIfMissing("schedules", "last_result", "last_result TEXT");
  addColumnIfMissing("devices", "last_seen", "last_seen DATETIME");
}

export function log(level: string, message: string) {
  try {
    db.run("INSERT INTO system_logs (level, message) VALUES (?, ?)", [level, String(message).slice(0, 2000)]);
  } catch {}
  console.log(`[MUSETRACK][${level}] ${message}`);
}

/** Fold the WAL back into the main .sqlite file (call before copying the DB anywhere). */
export function checkpoint() {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
}
