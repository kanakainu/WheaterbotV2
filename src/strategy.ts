import { buyYesLimit, getClobClient, sellYesLimit } from "./clob";
import { BotConfig, getActiveLocations } from "./config";
import { badge, C, divider, info, ok, panel, progressBar, skip, stat, warn } from "./colors";
import { DailyForecast, getForecast, getCityData } from "./forecast";
import { LOCATIONS } from "./nws";
import { hoursUntilResolution, parseTempRange } from "./parsing";
import {
  PolymarketEvent,
  PolymarketMarket,
  getPolymarketEvent,
  getMarketYesPrice,
  getYesTokenId
} from "./polymarket";
import { Position, Trade, loadSim, saveSim } from "./simState";
import { MONTHS } from "./time";
import type { ClobClient } from "@polymarket/clob-client";
import { calculateKellyPosition, calculateStopLoss, isStopLossHit } from "./risk";

// =============================================================================
// PARAMETER & INTERFACE
// =============================================================================

const FALLBACK_POSITION_PCT = 0.05;
const MIN_PAPER_ORDER_USD = 0.5;
const MIN_EXECUTE_ORDER_USD = 1.0;
const KELLY_FRACTION = 0.25;
const STOP_LOSS_PCT = 0.20;
const TRAILING_ACTIVATE_PCT = 0.20;
const TRAILING_RETRACE_PCT = 0.85; // 15% retracement from peak

interface PositionWithTracker extends Position {
  highestPrice?: number;
  trailingActive?: boolean;
  trailingStopPrice?: number;
}

export type TradeMode = "dry-run" | "paper" | "execute";

export interface RunOptions {
  mode: TradeMode;
  config: BotConfig;
  walletUsd?: number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function modeTone(mode: TradeMode): "green" | "yellow" | "cyan" {
  if (mode === "execute") return "green";
  if (mode === "paper") return "yellow";
  return "cyan";
}

function modeText(mode: TradeMode): string {
  if (mode === "execute") return "LIVE EXECUTION";
  if (mode === "paper") return "PAPER TRADING";
  return "SIGNAL ONLY";
}

function priceTone(price: number, entry: number, exit: number): "green" | "yellow" | "red" {
  if (price < entry) return "green";
  if (price >= exit) return "red";
  return "yellow";
}

function shortQuestion(question: string, max = 62): string {
  return question.length > max ? `${question.slice(0, max - 1)}…` : question;
}

function getUnitDisplay(citySlug: string): string {
  const cityData = LOCATIONS[citySlug as keyof typeof LOCATIONS];
  return cityData?.unit || 'F';
}

function calculatePositionSizeWithKelly(
  balance: number,
  probability: number,
  price: number,
  mode: TradeMode
): number {
  const kellyPercent = calculateKellyPosition(probability, price);
  let positionPct = kellyPercent;
  if (positionPct <= 0 || !isFinite(positionPct)) {
    positionPct = FALLBACK_POSITION_PCT;
    warn(`Kelly returned ${kellyPercent}, falling back to ${FALLBACK_POSITION_PCT * 100}%`);
  }
  positionPct = Math.min(positionPct, 0.15);
  const minOrderUsd = mode === "execute" ? MIN_EXECUTE_ORDER_USD : MIN_PAPER_ORDER_USD;
  let positionSize = balance * positionPct;
  if (positionSize < minOrderUsd) positionSize = minOrderUsd;
  return Number(positionSize.toFixed(2));
}

// =============================================================================
// EXIT LOGIC WITH FIXED TRAILING STOP
// =============================================================================
async function checkAndExecuteExit(
  marketId: string,
  pos: PositionWithTracker,
  currentPrice: number,
  mode: TradeMode,
  clob: ClobClient | undefined,
  balanceRef: { value: number },
  sim: any,
  positions: Record<string, PositionWithTracker>
): Promise<boolean> {
  const entryPrice = pos.entry_price;
  
  // FIX #1: Inisialisasi highestPrice
  if (pos.highestPrice === undefined || pos.highestPrice === null) {
    pos.highestPrice = entryPrice;
  }
  
  // Update highest price
  if (currentPrice > pos.highestPrice) {
    pos.highestPrice = currentPrice;
    console.log(`[TRAILING] ${pos.question.slice(0,40)}... peak: $${pos.highestPrice.toFixed(4)}`);
  }
  
  // STOP LOSS BIASA
  if (isStopLossHit(entryPrice, currentPrice)) {
    const loss = (currentPrice - entryPrice) * pos.shares;
    console.log(panel(`🛑 STOP LOSS • ${shortQuestion(pos.question, 56)}`, [
      stat("Entry", `$${entryPrice.toFixed(3)}`, "cyan"),
      stat("Stop", `$${calculateStopLoss(entryPrice).toFixed(3)}`, "red"),
      stat("Now", `$${currentPrice.toFixed(3)}`, "red"),
      stat("Loss", `-$${Math.abs(loss).toFixed(2)}`, "red"),
    ], "red"));
    
    if (mode === "execute" && clob && pos.token_id) {
      try {
        await sellYesLimit(clob, pos.token_id, Math.max(currentPrice - 0.01, 0.01), pos.shares);
        ok("CLOB sell order submitted (stop loss)");
      } catch (e) { warn(`CLOB sell failed: ${String(e)}`); return false; }
    }
    
    balanceRef.value += pos.cost + loss;
    (loss > 0 ? sim.wins : sim.losses) += 1;
    sim.trades.push({ type: "exit", question: pos.question, entry_price: entryPrice, exit_price: currentPrice, pnl: Number(loss.toFixed(2)), cost: pos.cost, closed_at: new Date().toISOString() });
    delete positions[marketId];
    ok(`Stop loss closed — PnL: ${loss >= 0 ? "+" : ""}${loss.toFixed(2)}`);
    return true;
  }
  
  // FIX #2 & #3: TRAILING STOP LOGIC YANG BENAR
  const activateThreshold = entryPrice * (1 + TRAILING_ACTIVATE_PCT);
  const isTrailingActive = pos.trailingActive === true;
  
  // Aktifkan trailing stop kalo udah profit >=20% dan belum aktif
  if (!isTrailingActive && currentPrice >= activateThreshold) {
    pos.trailingActive = true;
    pos.trailingStopPrice = currentPrice * TRAILING_RETRACE_PCT;
    console.log(`[TRAILING ACTIVATED] ${pos.question.slice(0,40)}... stop: $${pos.trailingStopPrice.toFixed(4)}`);
  }
  
  // Update trailing stop price kalo harga naik lebih tinggi
  if (pos.trailingActive && pos.highestPrice) {
    const newStop = pos.highestPrice * TRAILING_RETRACE_PCT;
    if (newStop > (pos.trailingStopPrice || 0)) {
      pos.trailingStopPrice = newStop;
      console.log(`[TRAILING UPDATED] ${pos.question.slice(0,40)}... stop: $${newStop.toFixed(4)}`);
    }
  }
  
  // Cek kena trailing stop
  if (pos.trailingActive && pos.trailingStopPrice && currentPrice <= pos.trailingStopPrice) {
    const profit = (currentPrice - entryPrice) * pos.shares;
    console.log(panel(`🎯 TRAILING STOP • ${shortQuestion(pos.question, 56)}`, [
      stat("Entry", `$${entryPrice.toFixed(3)}`, "cyan"),
      stat("Peak", `$${(pos.highestPrice || entryPrice).toFixed(3)}`, "green"),
      stat("Exit", `$${currentPrice.toFixed(3)}`, "yellow"),
      stat("Profit", `+$${profit.toFixed(2)}`, "green"),
    ], "green"));
    
    if (mode === "execute" && clob && pos.token_id) {
      try {
        await sellYesLimit(clob, pos.token_id, Math.max(currentPrice - 0.01, 0.01), pos.shares);
        ok("CLOB sell order submitted (trailing stop)");
      } catch (e) { warn(`CLOB sell failed: ${String(e)}`); return false; }
    }
    
    balanceRef.value += pos.cost + profit;
    sim.wins += 1;
    sim.trades.push({ type: "exit", question: pos.question, entry_price: entryPrice, exit_price: currentPrice, pnl: Number(profit.toFixed(2)), cost: pos.cost, closed_at: new Date().toISOString() });
    delete positions[marketId];
    ok(`Trailing stop closed — Profit: +$${profit.toFixed(2)}`);
    return true;
  }
  
  return false;
}

// =============================================================================
// SHOW POSITIONS
// =============================================================================
export async function showPositions(): Promise<void> {
  const sim = await loadSim();
  const positions = sim.positions;
  console.log("\n" + panel("Open Positions", [
    stat("Balance", `$${sim.balance.toFixed(2)}`, "cyan"),
    stat("Open", `${Object.keys(positions).length}`, "blue"),
    stat("Trades", `${sim.total_trades}`, "magenta"),
    stat("W/L", `${sim.wins}/${sim.losses}`, "yellow")
  ], "blue"));
  
  const mids = Object.keys(positions);
  if (!mids.length) {
    console.log(panel("Portfolio Status", [C.GRAY("No open positions")], "gray"));
    return;
  }

  let totalUnrealized = 0;
  for (const mid of mids) {
    const pos = positions[mid] as PositionWithTracker;
    const currentPrice = (await getMarketYesPrice(mid)) ?? pos.entry_price;
    const unrealized = (currentPrice - pos.entry_price) * pos.shares;
    totalUnrealized += unrealized;
    const stopPrice = calculateStopLoss(pos.entry_price);
    let riskInfo = stat("Stop loss", `$${stopPrice.toFixed(3)} (${STOP_LOSS_PCT*100}%)`, "yellow");
    if (pos.trailingActive && pos.highestPrice) {
      riskInfo = stat("Trailing active", `Peak: $${pos.highestPrice.toFixed(3)} → stop: $${(pos.trailingStopPrice || 0).toFixed(3)}`, "green");
    }
    console.log("\n" + panel(shortQuestion(pos.question, 68), [
      stat("Entry", `$${pos.entry_price.toFixed(3)}`, "cyan"),
      stat("Now", `$${currentPrice.toFixed(3)}`, unrealized >=0 ? "green" : "red"),
      riskInfo,
      stat("Shares", pos.shares.toFixed(1), "blue"),
      stat("PnL", `${unrealized >=0 ? "+" : ""}$${unrealized.toFixed(2)}`, unrealized >=0 ? "green" : "red"),
    ], unrealized >=0 ? "green" : "red"));
  }
  console.log("\n" + panel("Summary", [
    stat("Balance", `$${sim.balance.toFixed(2)}`, "cyan"),
    stat("Unrealized PnL", `${totalUnrealized >=0 ? "+" : ""}$${totalUnrealized.toFixed(2)}`, totalUnrealized >=0 ? "green" : "red"),
    stat("W/L", `${sim.wins}/${sim.losses}`, "yellow")
  ], totalUnrealized >=0 ? "green" : "red"));
}

// =============================================================================
// MAIN RUN FUNCTION
// =============================================================================
export async function run(options: RunOptions): Promise<void> {
  const { mode, config } = options;
  const sim = await loadSim();
  let balance = mode === "execute" && options.walletUsd != null ? options.walletUsd : sim.balance;
  const positions = sim.positions as Record<string, PositionWithTracker>;
  let tradesExecuted = 0, exitsFound = 0;
  let clob: ClobClient | undefined;
  if (mode === "execute") {
    try { clob = await getClobClient(config); } 
    catch (e) { warn(`Failed to init CLOB: ${String(e)}`); return; }
  }

  console.log("\n" + panel("Weather Trading Bot (UPGRADED)", [
    `${badge(modeText(mode), modeTone(mode))}`,
    stat("Balance", `$${balance.toFixed(2)}`, "cyan"),
    stat("Position sizing", `${KELLY_FRACTION*100}% Kelly`, "blue"),
    stat("Stop loss", `${STOP_LOSS_PCT*100}%`, "red"),
    stat("Entry threshold", `< $${config.entry_threshold}`, "green"),
  ], modeTone(mode)));

  const balanceRef = { value: balance };
  const persist = mode === "paper" || mode === "execute";

  // EXIT SCAN
  console.log(`\n${divider("EXIT SCAN", "magenta")}`);
  for (const [mid, pos] of Object.entries(positions)) {
    const currentPrice = await getMarketYesPrice(mid);
    if (!currentPrice) continue;
    if (currentPrice >= config.exit_threshold) {
      exitsFound++;
      const profit = (currentPrice - pos.entry_price) * pos.shares;
      console.log(panel(`Take Profit • ${shortQuestion(pos.question, 50)}`, [
        stat("Exit", `$${currentPrice.toFixed(3)} >= $${config.exit_threshold}`, "green"),
        stat("Profit", `+$${profit.toFixed(2)}`, "green"),
      ], "green"));
      if (mode === "execute" && clob && pos.token_id) {
        try { await sellYesLimit(clob, pos.token_id, Math.max(currentPrice - 0.01, 0.01), pos.shares); }
        catch (e) { warn(`CLOB sell failed: ${String(e)}`); continue; }
      }
      balanceRef.value += pos.cost + profit;
      (profit > 0 ? sim.wins : sim.losses)++;
      sim.trades.push({ type: "exit", question: pos.question, entry_price: pos.entry_price, exit_price: currentPrice, pnl: Number(profit.toFixed(2)), cost: pos.cost, closed_at: new Date().toISOString() });
      delete positions[mid];
      ok(`Take profit closed — PnL: +$${profit.toFixed(2)}`);
      continue;
    }
    const exited = await checkAndExecuteExit(mid, pos, currentPrice, mode, clob, balanceRef, sim, positions);
    if (exited) exitsFound++;
  }
  if (!exitsFound) skip("No exit opportunities");

  // ENTRY SCAN
  console.log(`\n${divider("ENTRY SCAN", "cyan")}`);
  const activeLocations = getActiveLocations(config);
  for (const citySlug of activeLocations) {
    if (!(citySlug in LOCATIONS)) continue;
    const locData = LOCATIONS[citySlug as keyof typeof LOCATIONS];
    const forecast = await getForecast(citySlug);
    if (!forecast || Object.keys(forecast).length === 0) continue;
    const unit = getUnitDisplay(citySlug);
    
    for (let i = 0; i < 4; i++) {
      const date = new Date(); date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().slice(0,10);
      const month = MONTHS[date.getMonth()], day = date.getDate(), year = date.getFullYear();
      const forecastTemp = forecast[dateStr];
      if (!forecastTemp) continue;
      const event = await getPolymarketEvent(citySlug, month, day, year);
      if (!event) continue;
      const hoursLeft = hoursUntilResolution(event);
      console.log("\n" + panel(`${locData.name} • ${dateStr}`, [
        stat("Forecast", `${forecastTemp}°${unit}`, "cyan"),
        stat("Resolves in", `${hoursLeft.toFixed(0)}h`, hoursLeft < config.min_hours_to_resolution ? "red" : "green"),
      ], "blue"));
      if (hoursLeft < config.min_hours_to_resolution) { skip("Too soon"); continue; }
      
      let matched = null;
      for (const market of event.markets ?? []) {
        const rng = parseTempRange(market.question || "");
        if (rng && rng[0] <= forecastTemp && forecastTemp <= rng[1]) {
          const prices = JSON.parse(market.outcomePrices ?? "[0.5,0.5]") as number[];
          matched = { market, question: market.question, price: prices[0], range: rng };
          break;
        }
      }
      if (!matched) { skip(`No bucket for ${forecastTemp}°${unit}`); continue; }
      
      if (matched.price >= config.entry_threshold) { skip(`Price $${matched.price} >= $${config.entry_threshold}`); continue; }
      
      const estimatedProb = Math.min(0.95, Math.max(0.05, 1 - matched.price));
      const positionSize = calculatePositionSizeWithKelly(balanceRef.value, estimatedProb, matched.price, mode);
      if (positionSize < MIN_PAPER_ORDER_USD) { skip(`Position size $${positionSize} too small`); continue; }
      if (tradesExecuted >= config.max_trades_per_run) { skip(`Max trades reached`); continue; }
      if (positions[matched.market.id]) { skip("Already in market"); continue; }
      
      console.log(panel(`Entry Signal • ${locData.name}`, [
        stat("Price", `$${matched.price.toFixed(3)}`, "green"),
        stat("Size", `$${positionSize.toFixed(2)} (${((positionSize/balanceRef.value)*100).toFixed(1)}% of balance)`, "yellow"),
        stat("Stop loss", `$${(matched.price * (1-STOP_LOSS_PCT)).toFixed(3)} (${STOP_LOSS_PCT*100}%)`, "red"),
      ], "green"));
      
      const shares = positionSize / matched.price;
      if (mode === "execute" && clob) {
        const tokenId = getYesTokenId(matched.market);
        if (!tokenId) { warn("No token ID"); continue; }
        await buyYesLimit(clob, tokenId, Math.min(matched.price + 0.03, 0.99), shares);
      }
      if (mode !== "dry-run") balanceRef.value -= positionSize;
      
      positions[matched.market.id] = {
        question: matched.question,
        entry_price: matched.price,
        shares,
        cost: positionSize,
        date: dateStr,
        location: citySlug,
        forecast_temp: forecastTemp,
        opened_at: new Date().toISOString(),
        highestPrice: matched.price,
        trailingActive: false,
        trailingStopPrice: undefined
      };
      sim.total_trades++;
      sim.trades.push({ type: "entry", question: matched.question, entry_price: matched.price, shares, cost: positionSize, opened_at: new Date().toISOString() });
      tradesExecuted++;
      ok(`Position opened — $${positionSize.toFixed(2)} (${((positionSize/balanceRef.value+positionSize)*100).toFixed(1)}% of balance)`);
    }
  }
  
  if (persist) {
    sim.balance = Number(balanceRef.value.toFixed(2));
    sim.positions = positions;
    sim.peak_balance = Math.max(sim.peak_balance || balanceRef.value, balanceRef.value);
    await saveSim(sim);
  }
  
  console.log("\n" + panel("Run Summary", [
    stat("Balance", `$${balanceRef.value.toFixed(2)}`, "cyan"),
    stat("Trades", `${tradesExecuted}`, tradesExecuted > 0 ? "green" : "gray"),
    stat("Open", `${Object.keys(positions).length}`, "blue"),
  ], modeTone(mode)));
}
