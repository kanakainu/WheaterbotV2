// src/db.ts - SQLite database untuk state management (anti corrupt)
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'live.db');
const db = new Database(DB_PATH);

// Inisialisasi tabel
db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    market_id TEXT UNIQUE,
    question TEXT,
    entry_price REAL,
    shares REAL,
    cost REAL,
    date TEXT,
    location TEXT,
    forecast_temp REAL,
    opened_at TEXT,
    highest_price REAL,
    trailing_active INTEGER DEFAULT 0,
    trailing_stop_price REAL,
    status TEXT DEFAULT 'open',
    mode TEXT DEFAULT 'paper'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT,
    question TEXT,
    action TEXT,
    price REAL,
    shares REAL,
    cost REAL,
    pnl REAL,
    opened_at TEXT,
    closed_at TEXT,
    mode TEXT DEFAULT 'paper'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value REAL
  )
`);

// Inisialisasi balance kalo belum ada
const balanceRow = db.prepare('SELECT value FROM state WHERE key = "balance"').get();
if (!balanceRow) {
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run('balance', 200.0);
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run('starting_balance', 200.0);
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run('peak_balance', 200.0);
}

// ============= POSITION FUNCTIONS =============
export function savePosition(pos: any) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO positions 
    (id, market_id, question, entry_price, shares, cost, date, location, forecast_temp, 
     opened_at, highest_price, trailing_active, trailing_stop_price, status, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    pos.market_id, pos.market_id, pos.question, pos.entry_price, pos.shares, pos.cost,
    pos.date, pos.location, pos.forecast_temp, pos.opened_at,
    pos.highest_price || pos.entry_price, pos.trailing_active ? 1 : 0,
    pos.trailing_stop_price || null, pos.status || 'open', pos.mode || 'paper'
  );
}

export function loadOpenPositions(): any[] {
  return db.prepare('SELECT * FROM positions WHERE status = "open"').all();
}

export function loadAllPositions(): any[] {
  return db.prepare('SELECT * FROM positions ORDER BY opened_at DESC').all();
}

export function updatePositionExit(marketId: string, exitPrice: number, pnl: number, exitMode?: string) {
  return db.prepare(`
    UPDATE positions 
    SET status = 'closed', exit_price = ?, pnl = ?, closed_at = ?, close_reason = ?
    WHERE market_id = ?
  `).run(exitPrice, pnl, new Date().toISOString(), exitMode || 'manual', marketId);
}

export function updatePositionTrailing(marketId: string, highestPrice: number, trailingStopPrice: number) {
  return db.prepare(`
    UPDATE positions 
    SET highest_price = ?, trailing_stop_price = ?, trailing_active = 1
    WHERE market_id = ?
  `).run(highestPrice, trailingStopPrice, marketId);
}

export function deletePosition(marketId: string) {
  return db.prepare('DELETE FROM positions WHERE market_id = ?').run(marketId);
}

// ============= TRADE FUNCTIONS =============
export function saveTrade(trade: any) {
  const stmt = db.prepare(`
    INSERT INTO trades 
    (market_id, question, action, price, shares, cost, pnl, opened_at, closed_at, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    trade.market_id, trade.question, trade.action, trade.price, trade.shares, trade.cost,
    trade.pnl || null, trade.opened_at || null, trade.closed_at || null, trade.mode || 'paper'
  );
}

export function getTrades(mode?: string): any[] {
  if (mode) {
    return db.prepare('SELECT * FROM trades WHERE mode = ? ORDER BY id DESC').all(mode);
  }
  return db.prepare('SELECT * FROM trades ORDER BY id DESC').all();
}

// ============= BALANCE FUNCTIONS =============
export function getBalance(): number {
  const row = db.prepare('SELECT value FROM state WHERE key = "balance"').get() as { value: number } | undefined;
  return row?.value || 200.0;
}

export function setBalance(balance: number) {
  return db.prepare('UPDATE state SET value = ? WHERE key = "balance"').run(balance);
}

export function getStartingBalance(): number {
  const row = db.prepare('SELECT value FROM state WHERE key = "starting_balance"').get() as { value: number } | undefined;
  return row?.value || 200.0;
}

export function getPeakBalance(): number {
  const row = db.prepare('SELECT value FROM state WHERE key = "peak_balance"').get() as { value: number } | undefined;
  return row?.value || 200.0;
}

export function updatePeakBalance(balance: number) {
  const current = getPeakBalance();
  if (balance > current) {
    db.prepare('UPDATE state SET value = ? WHERE key = "peak_balance"').run(balance);
  }
}

export function getWinLoss(): { wins: number; losses: number } {
  const wins = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "exit" AND pnl > 0').get() as { count: number };
  const losses = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "exit" AND pnl < 0').get() as { count: number };
  return { wins: wins?.count || 0, losses: losses?.count || 0 };
}

export function getTotalTrades(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "entry"').get() as { count: number };
  return row?.count || 0;
}

// ============= RESET =============
export function resetAll() {
  db.prepare('DELETE FROM positions').run();
  db.prepare('DELETE FROM trades').run();
  db.prepare('UPDATE state SET value = 200.0 WHERE key = "balance"').run();
  db.prepare('UPDATE state SET value = 200.0 WHERE key = "starting_balance"').run();
  db.prepare('UPDATE state SET value = 200.0 WHERE key = "peak_balance"').run();
  return true;
}

export default db;
