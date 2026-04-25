// dashboard/server.ts - Realtime Dashboard Backend
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import Database from 'better-sqlite3';
import fs from 'fs';

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'live.db');
const db = new Database(dbPath);

// Create tables if not exists
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
    mode TEXT DEFAULT 'paper',
    current_price REAL,
    pnl REAL
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

// API Routes
app.get('/api/positions', (req, res) => {
  try {
    const positions = db.prepare('SELECT * FROM positions WHERE status = "open" ORDER BY opened_at DESC').all();
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/closed', (req, res) => {
  try {
    const closed = db.prepare('SELECT * FROM positions WHERE status = "closed" ORDER BY closed_at DESC LIMIT 50').all();
    res.json(closed);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/balance', (req, res) => {
  try {
    const balance = db.prepare('SELECT value FROM state WHERE key = "balance"').get() as { value: number } | undefined;
    const starting = db.prepare('SELECT value FROM state WHERE key = "starting_balance"').get() as { value: number } | undefined;
    const wins = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "exit" AND pnl > 0').get() as { count: number };
    const losses = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "exit" AND pnl < 0').get() as { count: number };
    res.json({
      balance: balance?.value || 0,
      starting: starting?.value || 0,
      wins: wins?.count || 0,
      losses: losses?.count || 0
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/trades', (req, res) => {
  try {
    const trades = db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 100').all();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const totalTrades = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "entry"').get() as { count: number };
    const totalPnl = db.prepare('SELECT SUM(pnl) as total FROM trades WHERE action = "exit" AND pnl IS NOT NULL').get() as { total: number | null };
    
    // Get daily PnL for chart
    const dailyPnl = db.prepare(`
      SELECT DATE(closed_at) as date, SUM(pnl) as pnl, COUNT(*) as trades
      FROM trades WHERE action = "exit" AND closed_at IS NOT NULL
      GROUP BY DATE(closed_at) ORDER BY date DESC LIMIT 30
    `).all();
    
    res.json({
      totalTrades: totalTrades?.count || 0,
      totalPnl: totalPnl?.total || 0,
      dailyPnl
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// WebSocket for realtime updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  const sendUpdates = () => {
    try {
      const positions = db.prepare('SELECT * FROM positions WHERE status = "open"').all();
      const balance = db.prepare('SELECT value FROM state WHERE key = "balance"').get() as { value: number } | undefined;
      const wins = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "exit" AND pnl > 0').get() as { count: number };
      const losses = db.prepare('SELECT COUNT(*) as count FROM trades WHERE action = "exit" AND pnl < 0').get() as { count: number };
      
      socket.emit('positions', positions);
      socket.emit('balance', balance?.value || 0);
      socket.emit('stats', { wins: wins?.count || 0, losses: losses?.count || 0 });
    } catch (error) {
      console.error('Update error:', error);
    }
  };
  
  sendUpdates();
  const interval = setInterval(sendUpdates, 5000);
  
  socket.on('disconnect', () => {
    clearInterval(interval);
    console.log('Client disconnected:', socket.id);
  });
});

// Serve static files
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.DASHBOARD_PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n📊 Dashboard running at http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop\n`);
});
