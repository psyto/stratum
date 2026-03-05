import Database from 'better-sqlite3';
import { config } from '../config';

let db: Database.Database;

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initDatabase(): void {
  const database = getDatabase();

  database.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      quicknode_id TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL,
      endpoint_id TEXT,
      chain TEXT,
      network TEXT,
      wss_url TEXT,
      http_url TEXT,
      referers TEXT DEFAULT '[]',
      contract_addresses TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      deactivated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}
