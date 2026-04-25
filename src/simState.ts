// src/simState.ts - VERSI SQLITE (anti corrupt)
import { ok, warn } from "./colors";
import * as db from "./db";

export interface Position {
  market_id?: string;
  question: string;
  entry_price: number;
  shares: number;
  cost: number;
  date: string;
  location: string;
  forecast_temp: number;
  opened_at: string;
  token_id?: string;
  pnl?: number;
  highestPrice?: number;
  trailingActive?: boolean;
  trailingStopPrice?: number;
  status?: string;
}

export interface Trade {
  market_id?: string;
  question: string;
  action: "entry" | "exit";
  price: number;
  shares?: number;
  cost: number;
  pnl?: number;
  opened_at?: string;
  closed_at?: string;
}

export interface SimulationState {
  balance: number;
  starting_balance: number;
  positions: Record<string, Position>;
  trades: any[];
  total_trades: number;
  wins: number;
  losses: number;
  peak_balance: number;
}

export async function loadSim(): Promise<SimulationState> {
  const balance = db.getBalance();
  const startingBalance = db.getStartingBalance();
  const peakBalance = db.getPeakBalance();
  const { wins, losses } = db.getWinLoss();
  const totalTrades = db.getTotalTrades();
  const trades = db.getTrades();
  
  // Load open positions ke format Record untuk kompatibilitas
  const openPositions = db.loadOpenPositions();
  const positions: Record<string, Position> = {};
  for (const pos of openPositions) {
    positions[pos.market_id] = {
      market_id: pos.market_id,
      question: pos.question,
      entry_price: pos.entry_price,
      shares: pos.shares,
      cost: pos.cost,
      date: pos.date,
      location: pos.location,
      forecast_temp: pos.forecast_temp,
      opened_at: pos.opened_at,
      token_id: pos.token_id,
      pnl: pos.pnl,
      highestPrice: pos.highest_price,
      trailingActive: pos.trailing_active === 1,
      trailingStopPrice: pos.trailing_stop_price,
      status: pos.status
    };
  }
  
  return {
    balance,
    starting_balance: startingBalance,
    positions,
    trades,
    total_trades: totalTrades,
    wins,
    losses,
    peak_balance: peakBalance
  };
}

export async function saveSim(sim: SimulationState): Promise<void> {
  // Update balance
  db.setBalance(sim.balance);
  db.updatePeakBalance(sim.balance);
  
  // Simpan semua posisi yang masih open
  for (const [marketId, pos] of Object.entries(sim.positions)) {
    // Cek apakah posisi masih open di DB
    const existing = db.loadOpenPositions().find((p: any) => p.market_id === marketId);
    if (!existing && pos.status !== 'closed') {
      db.savePosition({
        market_id: marketId,
        question: pos.question,
        entry_price: pos.entry_price,
        shares: pos.shares,
        cost: pos.cost,
        date: pos.date,
        location: pos.location,
        forecast_temp: pos.forecast_temp,
        opened_at: pos.opened_at,
        highest_price: pos.highestPrice,
        trailing_active: pos.trailingActive ? 1 : 0,
        trailing_stop_price: pos.trailingStopPrice,
        status: pos.status || 'open'
      });
    }
  }
}

export async function resetSim(): Promise<void> {
  const result = db.resetAll();
  if (result) {
    ok(`Simulation reset — balance back to $200.00`);
  } else {
    warn(`Reset failed`);
  }
}
