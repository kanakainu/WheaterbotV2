import { buyYesLimit, getClobClient, sellYesLimit } from "./clob";
import { BotConfig, getActiveLocations } from "./config";
import { badge, C, divider, ok, panel, progressBar, skip, stat, warn } from "./colors";
import { DailyForecast, getForecast } from "./forecast";
import { getMultiModelEnsemble, calculateProbabilityFromEnsemble } from "./forecast-ensemble";
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
import { calculateStopLoss, isStopLossHit, adjustForDrawdown, getPositionSize } from "./risk";
import { isLiquidEnough, getBestBidAsk, getMarketVolume } from "./depth";
import { notifyTrade, notifyError } from "./notify";
import { CITIES } from "./cities";
import { calculateEdge, getEdgeTier, getEdgeMultiplier, getConfidence, rankCandidates, AlphaCandidate, getRegion, isCorrelated, calculateLiquidityScore, getLiquidityTier } from "./alpha";

// =============================================================================
// ALPHA HUNTING MODE - SWEET SPOT CONFIG
// =============================================================================

const FALLBACK_POSITION_PCT = 0.02;
const MAX_PORTFOLIO_EXPOSURE = 0.20;           // 20%
const MAX_OPEN_POSITIONS = 5;                  // 5 positions
const STOP_LOSS_PCT = 0.15;
const TRAILING_ACTIVATE_PCT = 0.15;
const TRAILING_RETRACE_PCT = 0.92;
const MAX_SLIPPAGE_PCT = 0.05;
const DEPTH_SLIPPAGE_TOL = 15;

// ALPHA HUNTING THRESHOLDS (Loosened but not degenerate)
const MIN_EDGE = 0.015;                        // 1.5% (bukan 1%)
const MIN_CONFIDENCE = 0.55;                   // 55%
const MIN_VOLUME_USD = 500;                    // 500 (khusus live)
const MAX_SPREAD_PERCENT = 0.05;               // 5% (bukan 6%)
const MIN_HOURS_LIQUID = 1;

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
  const cityData = CITIES[citySlug];
  return cityData?.unit || 'F';
}

function estimateModelProbability(forecastTemp: number, bucket: [number, number]): number {
  const low = bucket[0];
  const high = bucket[1];
  
  if (low === -999) {
    return Math.min(0.95, Math.max(0.05, 1 - (forecastTemp / high)));
  }
  if (high === 999) {
    return Math.min(0.95, Math.max(0.05, forecastTemp / low));
  }
  
  const range = high - low;
  const center = (low + high) / 2;
  const distanceToCenter = Math.abs(forecastTemp - center);
  
  if (forecastTemp >= low && forecastTemp <= high) {
    return 0.6 + (0.3 * (1 - (distanceToCenter / (range / 2))));
  } else {
    const outsideDist = Math.min(Math.abs(forecastTemp - low), Math.abs(forecastTemp - high));
    return Math.max(0.1, 0.4 - (outsideDist * 0.1));
  }
}

// ELEGANT BOUNDARY DECAY (bukan hard penalty)
function getBoundaryPenalty(forecastTemp: number, low: number, high: number): number {
  const distToLow = Math.abs(forecastTemp - low);
  const distToHigh = Math.abs(forecastTemp - high);
  const dist = Math.min(distToLow, distToHigh);
  
  if (dist < 1) return 0.85;      // Sangat dekat: 15% penalty
  if (dist < 2) return 0.93;      // Dekat: 7% penalty
  return 1.0;                      // Aman
}

function currentExposure(positions: Record<string, PositionWithTracker>): number {
  return Object.values(positions).reduce((sum, p) => sum + (p.cost || 0), 0);
}

function getOpenRegions(positions: Record<string, PositionWithTracker>): Set<string> {
  const regions = new Set<string>();
  for (const pos of Object.values(positions)) {
    regions.add(getRegion(pos.location));
  }
  return regions;
}

function calculatePositionSizeWithConfidenceKelly(
  balance: number,
  modelProb: number,
  marketPrice: number,
  confidence: number,
  mode: TradeMode,
  losingStreak: number = 0
): number {
  let positionPct = getPositionSize(modelProb, marketPrice, confidence, losingStreak);
  
  if (positionPct <= 0) return 0;
  
  let positionSize = balance * positionPct;
  
  const minOrderUsd = mode === "execute" ? MIN_EXECUTE_ORDER_USD : MIN_PAPER_ORDER_USD;
  if (positionSize < minOrderUsd) positionSize = minOrderUsd;
  
  return Number(positionSize.toFixed(2));
}

// =============================================================================
// EXIT LOGIC
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
// MAIN RUN FUNCTION - ALPHA HUNTING MODE
// =============================================================================
export async function run(options: RunOptions): Promise<void> {
  const { mode, config } = options;
  const sim = await loadSim();
  let balance = mode === "execute" && options.walletUsd != null ? options.walletUsd : sim.balance;
  const positions = sim.positions as Record<string, PositionWithTracker>;
  let tradesExecuted = 0, exitsFound = 0;
  let clob: ClobClient | undefined;
  
  // Alpha funnel metrics
  let scanned = 0;
  let passedEdge = 0;
  let passedConf = 0;
  let passedLiquidity = 0;
  let finalCandidatesCount = 0;

  if (mode === "execute") {
    try { clob = await getClobClient(config); } 
    catch (e) { 
      warn(`Failed to init CLOB: ${String(e)}`);
      return;
    }
  }

  const lastTrades = sim.trades.slice(-10);
  let losingStreak = 0;
  for (let i = lastTrades.length - 1; i >= 0; i--) {
    if (lastTrades[i].pnl && lastTrades[i].pnl < 0) losingStreak++;
    else break;
  }

  if (losingStreak >= 4 && mode !== "dry-run") {
    warn(`Losing streak ${losingStreak} >= 4, halting bot`);
    return;
  }

  console.log("\n" + panel("Weather Trading Bot (ALPHA HUNTING MODE)", [
    `${badge(modeText(mode), modeTone(mode))}`,
    stat("Balance", `$${balance.toFixed(2)}`, "cyan"),
    stat("Max position", `3% of balance`, "blue"),
    stat("Stop loss", `${STOP_LOSS_PCT*100}%`, "red"),
    stat("Min edge", `${MIN_EDGE*100}%`, "green"),
    stat("Min confidence", `${MIN_CONFIDENCE*100}%`, "green"),
    stat("Max spread", `${MAX_SPREAD_PERCENT*100}%`, "yellow"),
    stat("Max exposure", `${MAX_PORTFOLIO_EXPOSURE*100}%`, "yellow"),
    stat("Max open", `${MAX_OPEN_POSITIONS}`, "yellow"),
    stat("Losing streak", `${losingStreak}`, losingStreak >= 2 ? "red" : "yellow"),
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

  // ENTRY SCAN - ALPHA HUNTING
  console.log(`\n${divider("ENTRY SCAN (Alpha Hunting)", "cyan")}`);
  const activeLocations = getActiveLocations(config);
  const candidates: AlphaCandidate[] = [];

  const openCount = Object.keys(positions).length;
  if (openCount >= MAX_OPEN_POSITIONS) {
    skip(`Max open positions reached: ${openCount}/${MAX_OPEN_POSITIONS}`);
  } else {
    const exposure = currentExposure(positions);
    if (exposure > balanceRef.value * MAX_PORTFOLIO_EXPOSURE) {
      skip(`Exposure cap hit: ${((exposure/balanceRef.value)*100).toFixed(1)}% > ${MAX_PORTFOLIO_EXPOSURE*100}%`);
    } else {
      const openRegions = getOpenRegions(positions);
      
      for (const citySlug of activeLocations) {
        if (!(citySlug in LOCATIONS)) continue;
        const locData = LOCATIONS[citySlug as keyof typeof LOCATIONS];
        const cityData = CITIES[citySlug];
        const unit = cityData?.unit || 'F';
        
        const region = getRegion(citySlug);
        if (openRegions.has(region)) {
          continue;
        }
        
        for (let i = 0; i < 4; i++) {
          const date = new Date(); date.setDate(date.getDate() + i);
          const dateStr = date.toISOString().slice(0,10);
          const month = MONTHS[date.getMonth()], day = date.getDate(), year = date.getFullYear();
          
          scanned++;
          
          let forecastTemp: number | null = null;
          let modelProb: number = 0.5;
          let usedEnsemble = false;
          let disagreementScore = 0;
          let consensus = true;
          
          if (cityData && config.use_ensemble) {
            const multiModel = await getMultiModelEnsemble(cityData, dateStr);
            if (multiModel.forecasts.length > 0) {
              forecastTemp = multiModel.weightedForecast;
              usedEnsemble = true;
              disagreementScore = multiModel.disagreementScore;
              consensus = multiModel.consensus;
              
              if (!consensus && disagreementScore > (cityData.unit === 'F' ? 3.0 : 1.8)) {
                console.log(`[ALPHA] High disagreement! ${disagreementScore.toFixed(1)}°${cityData.unit} - chaos opportunity`);
              }
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
          
          if (hoursLeft < MIN_HOURS_LIQUID) { continue; }
          
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
              
              if (usedEnsemble && cityData) {
                const multiModel = await getMultiModelEnsemble(cityData, dateStr);
                if (multiModel.forecasts.length > 0) {
                  const allSamples: number[] = [];
                  for (const f of multiModel.forecasts) {
                    for (let s = 0; s < 10; s++) {
                      allSamples.push(f.forecast + (Math.random() - 0.5) * 2);
                    }
                  }
                  modelProb = calculateProbabilityFromEnsemble(allSamples, rng[0], rng[1]);
                } else {
                  // FALLBACK: turunin confidence, jangan naikin conviction
                  modelProb = 0.60;
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
          if (!matched) { continue; }
          
          const price = Number(matched.price);
          if (isNaN(price)) { continue; }
          
          let edge = calculateEdge(modelProb, price);
          const isDisagreementTrade = !consensus && disagreementScore > (cityData?.unit === 'F' ? 3.0 : 1.8);
          
          if (isDisagreementTrade) {
            edge = edge * 1.3;  // Disagreement boost
            console.log(`[ALPHA] Disagreement boost: ${(edge*100).toFixed(1)}% edge`);
          }
          
          // BOUNDARY DECAY (bukan hard penalty)
          const boundaryPenalty = getBoundaryPenalty(forecastTemp, matched.range[0], matched.range[1]);
          let finalEdge = edge * boundaryPenalty;
          
          if (boundaryPenalty < 1.0) {
            console.log(`[BOUNDARY] ${citySlug}: penalty ${((1-boundaryPenalty)*100).toFixed(0)}% applied`);
          }
          
          // Get confidence (with fallback penalty jika no ensemble)
          let confidence = getConfidence(modelProb);
          if (!usedEnsemble) {
            confidence *= 0.85;  // Turunin confidence kalo pake deterministic fallback
          }
          
          // ALPHA FUNNEL METRICS
          if (finalEdge < MIN_EDGE) {
            console.log(`[DEBUG EDGE] ${citySlug}: prob=${(modelProb*100).toFixed(1)}% price=${(price*100).toFixed(1)}% rawEdge=${(edge*100).toFixed(2)}% penalty=${boundaryPenalty} finalEdge=${(finalEdge*100).toFixed(2)}% < ${MIN_EDGE*100}%`);
            continue;
          }
          passedEdge++;
          
          if (confidence < MIN_CONFIDENCE) {
            console.log(`[DEBUG CONF] ${citySlug}: confidence=${(confidence*100).toFixed(0)}% < ${MIN_CONFIDENCE*100}%`);
            continue;
          }
          passedConf++;
          
          let bestPriceData = null;
          let volume = { volume24h: 0, volume7d: 0 };
          let tokenIdCheck = null;
          
          tokenIdCheck = getYesTokenId(matched.market);
          
          // VOLUME FILTER: ONLY FOR LIVE MODE (PAPER BYPASS)
          if (mode === "execute" && tokenIdCheck) {
            volume = await getMarketVolume(tokenIdCheck);
            if (volume.volume24h < MIN_VOLUME_USD) {
              continue;
            }
          } else if (mode === "paper" && tokenIdCheck) {
            // Paper mode: hanya untuk info, tidak di-filter
            volume = await getMarketVolume(tokenIdCheck);
          }
          
          if (tokenIdCheck && mode !== "dry-run") {
            bestPriceData = await getBestBidAsk(tokenIdCheck);
            
            if (bestPriceData && bestPriceData.spreadPercent > MAX_SPREAD_PERCENT) {
              console.log(`[DEBUG SPREAD] ${citySlug}: spread=${(bestPriceData.spreadPercent*100).toFixed(1)}% > ${MAX_SPREAD_PERCENT*100}%`);
              continue;
            }
          }
          
          const depthUSDC = (bestPriceData?.askSize || 0) * (bestPriceData?.ask || price);
          const liquidityMetrics = calculateLiquidityScore(depthUSDC, volume.volume24h, bestPriceData?.spreadPercent || 0.03);
          
          if (!liquidityMetrics.isLiquid && mode === "execute") {
            console.log(`[DEBUG LIQ] ${citySlug}: score=${liquidityMetrics.totalScore} tier=${liquidityMetrics.isLiquid ? 'OK' : 'BAD'}`);
            continue;
          }
          passedLiquidity++;
          
          const edgeMultiplier = getEdgeMultiplier(finalEdge);
          let positionSize = calculatePositionSizeWithConfidenceKelly(
            balanceRef.value, modelProb, price, confidence, mode, losingStreak
          );
          positionSize = positionSize * edgeMultiplier;
          positionSize = Math.min(positionSize, balanceRef.value * 0.05);
          
          if (positionSize <= 0) continue;
          
          candidates.push({
            marketId: matched.market.id,
            tokenId: tokenIdCheck || undefined,
            price,
            modelProb,
            edge: finalEdge,
            spread: bestPriceData?.spread || 0,
            spreadPercent: bestPriceData?.spreadPercent || 0,
            spreadScore: bestPriceData?.spreadScore || 0,
            volume24h: volume.volume24h,
            depthUSDC,
            liquidityScore: liquidityMetrics.totalScore,
            liquidityTier: getLiquidityTier(liquidityMetrics.totalScore),
            question: matched.question,
            citySlug,
            region,
            forecastTemp,
            confidence
          });
          
          console.log(stat("Candidate", `${locData.name} edge=${(finalEdge*100).toFixed(1)}% liq=${liquidityMetrics.totalScore} ${isDisagreementTrade ? '🔥CHAOS' : ''}`, "green"));
        }
      }
    }
  }
  
  finalCandidatesCount = candidates.length;
  
  // ALPHA FUNNEL SUMMARY
  console.log(`\n${divider("ALPHA FUNNEL", "yellow")}`);
  console.log(`  Scanned: ${scanned}`);
  console.log(`  Passed Edge: ${passedEdge}`);
  console.log(`  Passed Confidence: ${passedConf}`);
  console.log(`  Passed Liquidity: ${passedLiquidity}`);
  console.log(`  Final Candidates: ${finalCandidatesCount}`);
  
  const rankedCandidates = rankCandidates(candidates);
  console.log(`\n${divider(`TOP ${rankedCandidates.length} CANDIDATES`, "green")}`);
  
  for (const cand of rankedCandidates) {
    if (tradesExecuted >= config.max_trades_per_run) break;
    if (positions[cand.marketId]) continue;
    
    const edgeMultiplier = getEdgeMultiplier(cand.edge);
    let positionSize = calculatePositionSizeWithConfidenceKelly(
      balanceRef.value, cand.modelProb, cand.price, cand.confidence, mode, losingStreak
    );
    positionSize = positionSize * edgeMultiplier;
    positionSize = Math.min(positionSize, balanceRef.value * 0.05);
    
    if (positionSize <= 0) {
      skip(`Position size too small for ${cand.citySlug}`);
      continue;
    }
    
    const shares = positionSize / cand.price;
    const edgeTier = getEdgeTier(cand.edge);
    
    console.log(panel(`🔥 EXECUTE • Edge ${(cand.edge*100).toFixed(1)}% (${edgeTier})`, [
      stat("Market", cand.citySlug, "cyan"),
      stat("Price", `$${cand.price.toFixed(3)}`, "green"),
      stat("Model Prob", `${(cand.modelProb*100).toFixed(1)}%`, "yellow"),
      stat("Confidence", `${(cand.confidence*100).toFixed(0)}%`, "yellow"),
      stat("Liquidity", `${cand.liquidityTier} (${cand.liquidityScore})`, "green"),
      stat("Size", `$${positionSize.toFixed(2)} (${((positionSize/balanceRef.value)*100).toFixed(1)}% of balance)`, "yellow"),
      stat("Stop loss", `$${(cand.price * (1 - STOP_LOSS_PCT)).toFixed(3)} (${STOP_LOSS_PCT*100}%)`, "red"),
    ].filter(Boolean), "green"));
    
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
    
    if (mode !== "dry-run") {
      await notifyTrade('buy', {
        question: cand.question,
        price: cand.price,
        size: positionSize,
        balance: balanceRef.value
      });
    }
    
    if (mode === "execute" && clob && cand.tokenId) {
      try {
        await buyYesLimit(clob, cand.tokenId, Math.min(cand.price + 0.03, 0.99), shares);
        ok(`CLOB buy order submitted`);
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
    ok(`Position opened — $${positionSize.toFixed(2)}`);
  }
  
  if (tradesExecuted === 0 && candidates.length === 0) skip("No candidates found");
  else if (tradesExecuted === 0) skip(`Filtered: ${candidates.length} candidates but none executed`);
  
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
    stat("Scanned", `${scanned}`, "gray"),
    stat("Losing streak", `${losingStreak}`, losingStreak >= 2 ? "red" : "yellow"),
  ], modeTone(mode)));
}
