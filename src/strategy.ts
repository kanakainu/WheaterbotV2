import { buyYesLimit, getClobClient, sellYesLimit } from "./clob";
import { BotConfig, getActiveLocations } from "./config";
import { badge, C, divider, ok, panel, progressBar, skip, stat, warn } from "./colors";
import { DailyForecast, getForecast, getCityData } from "./forecast";
import { getEnsembleTemperatures, calculateProbabilityFromEnsemble, isConfidentEnough } from "./forecast-ensemble";
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
import { calculateKellyPosition, calculateStopLoss, isStopLossHit, adjustForDrawdown } from "./risk";
import { isLiquidEnough, getBestBidAsk, getMarketVolume } from "./depth";
import { notifyTrade, notifyError } from "./notify";
import { rankCandidates, AlphaCandidate, getConfidence } from "./alpha";

// =============================================================================
// PARAMETER & INTERFACE (UPGRADED)
// =============================================================================

const FALLBACK_POSITION_PCT = 0.03;      // 3% fallback
const KELLY_FRACTION = 0.25;
const MAX_POSITION_PCT = 0.05;            // 5% max per trade
const MAX_PORTFOLIO_EXPOSURE = 0.30;       // Max 30% total exposure
const STOP_LOSS_PCT = 0.15;               // 15% stop loss
const TRAILING_ACTIVATE_PCT = 0.15;       // Aktif setelah profit 15%
const TRAILING_RETRACE_PCT = 0.92;        // Trail 8% dari peak
const MAX_SLIPPAGE_PCT = 0.03;            // 3% slippage tolerance
const DEPTH_SLIPPAGE_TOL = 5;             // 5% depth tolerance
const MIN_EDGE = 0.08;                    // Minimum edge 8% (dari 5%)
const MIN_HOURS_LIQUID = 2;
const MIN_VOLUME_USD = 10000;              // Minimal volume $10k

const MIN_PAPER_ORDER_USD = 0.5;
const MIN_EXECUTE_ORDER_USD = 1.0;

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
  const cityInfo = getCityData(citySlug);
  return cityInfo?.unit || 'F';
}

/**
 * Estimate model probability based on forecast distance to bucket center
 */
function estimateModelProbability(forecastTemp: number, bucket: [number, number]): number {
  const center = (bucket[0] + bucket[1]) / 2;
  const dist = Math.abs(forecastTemp - center);
  
  if (dist === 0) return 0.72;
  if (dist <= 1) return 0.63;
  if (dist <= 2) return 0.57;
  return 0.50;
}

/**
 * Check if forecast is near bucket boundary (0.5°F from edge)
 */
function nearBoundary(temp: number, low: number, high: number): boolean {
  return (temp - low < 0.5) || (high - temp < 0.5);
}

/**
 * Hitung total exposure dari semua posisi terbuka
 */
function currentExposure(positions: Record<string, PositionWithTracker>): number {
  return Object.values(positions).reduce((sum, p) => sum + (p.cost || 0), 0);
}

function calculatePositionSizeWithKelly(
  balance: number,
  modelProb: number,
  marketPrice: number,
  mode: TradeMode,
  losingStreak: number = 0
): number {
  const rawKelly = calculateKellyPosition(modelProb, marketPrice);
  let positionPct = rawKelly * KELLY_FRACTION;
  
  if (!isFinite(positionPct) || positionPct <= 0) {
    positionPct = FALLBACK_POSITION_PCT;
    warn(`Kelly returned ${rawKelly}, falling back to ${FALLBACK_POSITION_PCT * 100}%`);
  }
  
  positionPct = Math.min(positionPct, MAX_POSITION_PCT);
  
  // Apply drawdown adjustment
  let positionSize = balance * positionPct;
  positionSize = adjustForDrawdown(positionSize, losingStreak);
  
  const minOrderUsd = mode === "execute" ? MIN_EXECUTE_ORDER_USD : MIN_PAPER_ORDER_USD;
  if (positionSize < minOrderUsd) positionSize = minOrderUsd;
  
  return Number(positionSize.toFixed(2));
}

// =============================================================================
// EXIT LOGIC (with upgraded trailing)
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
  
  if (pos.highestPrice === undefined || pos.highestPrice === null) {
    pos.highestPrice = entryPrice;
  }
  
  if (currentPrice > pos.highestPrice) {
    pos.highestPrice = currentPrice;
    console.log(`[TRAILING] ${pos.question.slice(0,40)}... peak: $${pos.highestPrice.toFixed(4)}`);
  }
  
  // STOP LOSS (15%)
  if (isStopLossHit(entryPrice, currentPrice)) {
    const loss = (currentPrice - entryPrice) * pos.shares;
    console.log(panel(`🛑 STOP LOSS • ${shortQuestion(pos.question, 56)}`, [
      stat("Entry", `$${entryPrice.toFixed(3)}`, "cyan"),
      stat("Stop", `$${calculateStopLoss(entryPrice).toFixed(3)}`, "red"),
      stat("Now", `$${currentPrice.toFixed(3)}`, "red"),
      stat("Loss", `-$${Math.abs(loss).toFixed(2)}`, "red"),
    ], "red"));
    
    await notifyTrade('stop_loss', {
      question: pos.question,
      price: currentPrice,
      size: pos.cost,
      pnl: loss,
      balance: balanceRef.value
    });
    
    if (mode === "execute" && clob && pos.token_id) {
      try {
        await sellYesLimit(clob, pos.token_id, Math.max(currentPrice - 0.01, 0.01), pos.shares);
      } catch (e) { 
        warn(`CLOB sell failed: ${String(e)}`);
        return false;
      }
    }
    
    balanceRef.value += pos.cost + loss;
    if (loss > 0) sim.wins += 1;
    else sim.losses += 1;
    sim.trades.push({ type: "exit", question: pos.question, entry_price: entryPrice, exit_price: currentPrice, pnl: Number(loss.toFixed(2)), cost: pos.cost, closed_at: new Date().toISOString() });
    delete positions[marketId];
    ok(`Stop loss closed — PnL: ${loss >= 0 ? "+" : ""}${loss.toFixed(2)}`);
    return true;
  }
  
  // TRAILING STOP (trail 8%)
  const activateThreshold = entryPrice * (1 + TRAILING_ACTIVATE_PCT);
  const isTrailingActive = pos.trailingActive === true;
  
  if (!isTrailingActive && currentPrice >= activateThreshold) {
    pos.trailingActive = true;
    pos.trailingStopPrice = currentPrice * TRAILING_RETRACE_PCT;
    console.log(`[TRAILING ACTIVATED] ${pos.question.slice(0,40)}... stop: $${pos.trailingStopPrice.toFixed(4)}`);
  }
  
  if (pos.trailingActive && pos.highestPrice) {
    const newStop = pos.highestPrice * TRAILING_RETRACE_PCT;
    if (newStop > (pos.trailingStopPrice || 0)) {
      pos.trailingStopPrice = newStop;
      console.log(`[TRAILING UPDATED] ${pos.question.slice(0,40)}... stop: $${newStop.toFixed(4)}`);
    }
  }
  
  if (pos.trailingActive && pos.trailingStopPrice && currentPrice <= pos.trailingStopPrice) {
    const profit = (currentPrice - entryPrice) * pos.shares;
    console.log(panel(`🎯 TRAILING STOP • ${shortQuestion(pos.question, 56)}`, [
      stat("Entry", `$${entryPrice.toFixed(3)}`, "cyan"),
      stat("Peak", `$${(pos.highestPrice || entryPrice).toFixed(3)}`, "green"),
      stat("Exit", `$${currentPrice.toFixed(3)}`, "yellow"),
      stat("Profit", `+$${profit.toFixed(2)}`, "green"),
    ], "green"));
    
    await notifyTrade('take_profit', {
      question: pos.question,
      price: currentPrice,
      size: pos.cost,
      pnl: profit,
      balance: balanceRef.value
    });
    
    if (mode === "execute" && clob && pos.token_id) {
      try {
        await sellYesLimit(clob, pos.token_id, Math.max(currentPrice - 0.01, 0.01), pos.shares);
      } catch (e) { return false; }
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
// MAIN RUN FUNCTION (UPGRADED: edge-based, ranked)
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
    catch (e) { 
      warn(`Failed to init CLOB: ${String(e)}`);
      return;
    }
  }

  // Calculate losing streak from last 10 trades
  const lastTrades = sim.trades.slice(-10);
  let losingStreak = 0;
  for (let i = lastTrades.length - 1; i >= 0; i--) {
    if (lastTrades[i].pnl && lastTrades[i].pnl < 0) losingStreak++;
    else break;
  }

  console.log("\n" + panel("Weather Trading Bot (UPGRADED - Edge Trading)", [
    `${badge(modeText(mode), modeTone(mode))}`,
    stat("Balance", `$${balance.toFixed(2)}`, "cyan"),
    stat("Position sizing", `${KELLY_FRACTION*100}% Kelly (max 5%)`, "blue"),
    stat("Stop loss", `${STOP_LOSS_PCT*100}%`, "red"),
    stat("Min edge", `${MIN_EDGE*100}%`, "green"),
    stat("Losing streak", `${losingStreak}`, losingStreak >= 5 ? "red" : "yellow"),
  ], modeTone(mode)));

  if (mode !== "dry-run" && losingStreak >= 10) {
    warn("Losing streak >= 10, halting bot to preserve capital");
    return;
  }

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
      
      await notifyTrade('take_profit', {
        question: pos.question,
        price: currentPrice,
        size: pos.cost,
        pnl: profit,
        balance: balanceRef.value
      });
      
      if (mode === "execute" && clob && pos.token_id) {
        try { await sellYesLimit(clob, pos.token_id, Math.max(currentPrice - 0.01, 0.01), pos.shares); }
        catch (e) { continue; }
      }
      balanceRef.value += pos.cost + profit;
      if (profit > 0) sim.wins++;
      else sim.losses++;
      sim.trades.push({ type: "exit", question: pos.question, entry_price: pos.entry_price, exit_price: currentPrice, pnl: Number(profit.toFixed(2)), cost: pos.cost, closed_at: new Date().toISOString() });
      delete positions[mid];
      ok(`Take profit closed — PnL: +$${profit.toFixed(2)}`);
      continue;
    }
    const exited = await checkAndExecuteExit(mid, pos, currentPrice, mode, clob, balanceRef, sim, positions);
    if (exited) exitsFound++;
  }
  if (!exitsFound) skip("No exit opportunities");

  // =========================================================================
  // ENTRY SCAN - EDGE-BASED (UPGRADED)
  // =========================================================================
  console.log(`\n${divider("ENTRY SCAN (Alpha Ranking)", "cyan")}`);
  const activeLocations = getActiveLocations(config);
  const candidates: AlphaCandidate[] = [];

  for (const citySlug of activeLocations) {
    if (!(citySlug in LOCATIONS)) continue;
    const locData = LOCATIONS[citySlug as keyof typeof LOCATIONS];
    const cityData = getCityData(citySlug);
    const unit = cityData?.unit || 'F';
    
    for (let i = 0; i < 4; i++) {
      const date = new Date(); date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().slice(0,10);
      const month = MONTHS[date.getMonth()], day = date.getDate(), year = date.getFullYear();
      
      // Get forecast using ensemble if available
      let forecastTemp: number | null = null;
      let modelProb: number = 0.5;
      
      if (cityData && config.use_ensemble) {
        const samples = await getEnsembleTemperatures(cityData, dateStr);
        if (samples && samples.length) {
          // Need to find matching bucket first - will get bucket later
          // For now, we'll get the mean temp
          forecastTemp = samples.reduce((a,b) => a+b, 0) / samples.length;
          forecastTemp = Math.round(forecastTemp * 10) / 10;
        }
      }
      
      if (!forecastTemp) {
        const forecast = await getForecast(citySlug);
        forecastTemp = forecast[dateStr] || null;
      }
      
      if (!forecastTemp) continue;
      
      const event = await getPolymarketEvent(citySlug, month, day, year);
      if (!event) continue;
      const hoursLeft = hoursUntilResolution(event);
      
      console.log("\n" + panel(`${locData.name} • ${dateStr}`, [
        stat("Forecast", `${forecastTemp}°${unit}`, "cyan"),
        stat("Resolves in", `${hoursLeft.toFixed(0)}h`, hoursLeft < MIN_HOURS_LIQUID ? "red" : "green"),
      ], "blue"));
      
      if (hoursLeft < MIN_HOURS_LIQUID) { skip("Too soon"); continue; }
      
      let matched = null;
      for (const market of event.markets ?? []) {
        const rng = parseTempRange(market.question || "");
        if (rng && rng[0] <= forecastTemp && forecastTemp <= rng[1]) {
          let rawPrices = market.outcomePrices ?? "[0.5,0.5]";
          let prices;
          try {
            prices = JSON.parse(rawPrices) as number[];
          } catch {
            prices = [0.5, 0.5];
          }
          const yesPrice = Number(prices[0]);
          if (isNaN(yesPrice)) continue;
          
          // Calculate model probability (prioritize ensemble)
          if (cityData && config.use_ensemble) {
            const samples = await getEnsembleTemperatures(cityData, dateStr);
            if (samples) {
              modelProb = calculateProbabilityFromEnsemble(samples, rng[0], rng[1]);
            } else {
              modelProb = estimateModelProbability(forecastTemp, rng);
            }
          } else {
            modelProb = estimateModelProbability(forecastTemp, rng);
          }
          
          matched = {
            market,
            question: market.question,
            price: yesPrice,
            range: rng
          };
          break;
        }
      }
      if (!matched) { skip(`No bucket for ${forecastTemp}°${unit}`); continue; }
      
      const price = Number(matched.price);
      if (isNaN(price)) { skip(`Invalid price`); continue; }
      
      // === EDGE-BASED FILTER (BUKAN PRICE-BASED) ===
      const edge = modelProb - price;
      if (edge < MIN_EDGE) {
        skip(`Edge too low: ${(edge*100).toFixed(1)}% < ${MIN_EDGE*100}%`);
        continue;
      }
      
      // === CONFIDENCE FILTER ===
      if (!isConfidentEnough(modelProb)) {
        skip(`Low confidence: ${(modelProb*100).toFixed(1)}% < 62%`);
        continue;
      }
      
      // === BOUNDARY FILTER ===
      if (nearBoundary(forecastTemp, matched.range[0], matched.range[1])) {
        skip(`Near boundary: ${forecastTemp}°F at edge of bucket`);
        continue;
      }
      
      // === VOLUME FILTER ===
      const tokenId = getYesTokenId(matched.market);
      if (tokenId && mode !== "dry-run") {
        const volume = await getMarketVolume(tokenId);
        if (volume.volume24h < MIN_VOLUME_USD) {
          skip(`Low volume: $${volume.volume24h.toFixed(0)} < $${MIN_VOLUME_USD}`);
          continue;
        }
      }
      
      // === SPREAD FILTER (via bestBidAsk) ===
      if (tokenId && mode !== "dry-run") {
        const ba = await getBestBidAsk(tokenId);
        if (!ba || ba.spread > 0.04) {
          skip(`Wide spread: ${ba ? (ba.spread*100).toFixed(1) : 'N/A'}%`);
          continue;
        }
      }
      
      // === EXPOSURE CAP ===
      const exposure = currentExposure(positions);
      if (exposure > balanceRef.value * MAX_PORTFOLIO_EXPOSURE) {
        skip(`Exposure cap: $${exposure.toFixed(2)} > $${(balanceRef.value * MAX_PORTFOLIO_EXPOSURE).toFixed(2)}`);
        continue;
      }
      
      // === CANDIDATE FOR RANKING ===
      const confidence = getConfidence(modelProb);
      const spread = tokenId ? (await getBestBidAsk(tokenId))?.spread || 0.02 : 0.02;
      
      candidates.push({
        marketId: matched.market.id,
        tokenId: tokenId || undefined,
        price,
        modelProb,
        edge,
        spread,
        volume24h: tokenId ? (await getMarketVolume(tokenId)).volume24h : 0,
        question: matched.question,
        citySlug,
        forecastTemp,
        matchedMarket: matched.market
      });
      
      console.log(stat("Candidate", `${locData.name} edge=${(edge*100).toFixed(1)}% conf=${(confidence*100).toFixed(0)}%`, "green"));
    }
  }
  
  // === RANK CANDIDATES AND EXECUTE TOP 2 ===
  const rankedCandidates = rankCandidates(candidates);
  console.log(`\n${divider(`TOP ${rankedCandidates.length} CANDIDATES`, "green")}`);
  
  for (const cand of rankedCandidates) {
    if (tradesExecuted >= config.max_trades_per_run) break;
    if (positions[cand.marketId]) continue;
    
    const positionSize = calculatePositionSizeWithKelly(balanceRef.value, cand.modelProb, cand.price, mode, losingStreak);
    const shares = positionSize / cand.price;
    
    console.log(panel(`🔥 EXECUTE • Edge ${(cand.edge*100).toFixed(1)}%`, [
      stat("Market", cand.question.slice(0, 50), "cyan"),
      stat("Price", `$${cand.price.toFixed(3)}`, "green"),
      stat("Model Prob", `${(cand.modelProb*100).toFixed(1)}%`, "yellow"),
      stat("Size", `$${positionSize.toFixed(2)} (${((positionSize/balanceRef.value)*100).toFixed(1)}% of balance)`, "yellow"),
      stat("Stop loss", `$${(cand.price * (1 - STOP_LOSS_PCT)).toFixed(3)} (${STOP_LOSS_PCT*100}%)`, "red"),
    ], "green"));
    
    // === DEPTH CHECK BEFORE EXECUTION ===
    if (cand.tokenId && mode !== "dry-run") {
      const requiredShares = positionSize / cand.price;
      const isLiquid = await isLiquidEnough(cand.tokenId, requiredShares, DEPTH_SLIPPAGE_TOL);
      if (!isLiquid) {
        skip(`Not liquid enough for ${requiredShares.toFixed(1)} shares`);
        continue;
      }
      
      const ba = await getBestBidAsk(cand.tokenId);
      if (ba && ba.ask > cand.price * (1 + MAX_SLIPPAGE_PCT)) {
        skip(`Best ask ${ba.ask.toFixed(4)} > ${MAX_SLIPPAGE_PCT*100}% above price`);
        continue;
      }
    }
    
    // === TELEGRAM NOTIFICATION ===
    if (mode !== "dry-run") {
      await notifyTrade('buy', {
        question: cand.question,
        price: cand.price,
        size: positionSize,
        balance: balanceRef.value
      });
    }
    
    // === EXECUTE ===
    if (mode === "execute" && clob && cand.tokenId) {
      try {
        await buyYesLimit(clob, cand.tokenId, Math.min(cand.price + 0.03, 0.99), shares);
        ok(`CLOB buy order submitted @ limit $${Math.min(cand.price + 0.03, 0.99).toFixed(3)}`);
      } catch (e) {
        warn(`CLOB buy failed: ${String(e)}`);
        continue;
      }
    }
    
    if (mode !== "dry-run") balanceRef.value -= positionSize;
    
    positions[cand.marketId] = {
      question: cand.question,
      entry_price: cand.price,
      shares,
      cost: positionSize,
      date: new Date().toISOString().slice(0, 10),
      location: cand.citySlug,
      forecast_temp: cand.forecastTemp,
      opened_at: new Date().toISOString(),
      highestPrice: cand.price,
      trailingActive: false,
      trailingStopPrice: undefined
    };
    sim.total_trades++;
    sim.trades.push({ type: "entry", question: cand.question, entry_price: cand.price, shares, cost: positionSize, opened_at: new Date().toISOString() });
    tradesExecuted++;
    ok(`Position opened — $${positionSize.toFixed(2)} (${((positionSize/(balanceRef.value+positionSize))*100).toFixed(1)}% of balance)`);
  }
  
  if (tradesExecuted === 0 && candidates.length === 0) skip("No candidates found");
  else if (tradesExecuted === 0 && candidates.length > 0) skip("Candidates filtered by ranking");
  
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
    stat("Candidates", `${candidates.length}`, "yellow"),
  ], modeTone(mode)));
}
