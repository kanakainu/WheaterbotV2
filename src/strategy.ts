import { buyYesLimit, getClobClient, sellYesLimit } from "./clob";
import { BotConfig, getActiveLocations } from "./config";
import { badge, C, divider, info, ok, panel, progressBar, skip, stat, warn } from "./colors";
import { DailyForecast, getForecast, getCityData } from "./forecast";
import { LOCATIONS } from "./nws"; // LOCATIONS masih dipake buat mapping nama kota
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
import { calculateKellyPosition, calculateStopLoss, isStopLossHit, updateTrailingStop } from "./risk";

// =============================================================================
// KOMBINASI DARI BOT LAMA (PYTHON V2) + BOT BARU (TS)
// Kelly Criterion, Stop Loss, Trailing Stop
// =============================================================================

// BASE POSITION PERSENTAGE (FALLBACK KALO KELLY GAGAL)
const FALLBACK_POSITION_PCT = 0.05;  // 5% dari balance (sama kaya default)
const MIN_PAPER_ORDER_USD = 0.5;
const MIN_EXECUTE_ORDER_USD = 1.0;

// PARAMETER DARI BOT LAMA LO
const KELLY_FRACTION = 0.25;        // Fractional Kelly (25% dari full Kelly)
const STOP_LOSS_PCT = 0.20;          // Stop loss 20% dari entry
const PROFIT_TARGET = 0.55;          // Target profit $0.55 (dari exit threshold)
const TRAILING_ACTIVATE_PCT = 0.20;   // Aktifin trailing setelah profit 20%

// Interface buat nampung highest price per posisi (buat trailing stop)
interface PositionWithTracker extends Position {
  highestPrice?: number;  // Harga tertinggi yang pernah tercapai
}

export type TradeMode = "dry-run" | "paper" | "execute";

export interface RunOptions {
  mode: TradeMode;
  config: BotConfig;
  /** Polymarket CLOB collateral balance (USDC) — used for sizing in execute mode */
  walletUsd?: number;
}

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

function priceTone(
  price: number,
  entry: number,
  exit: number
): "green" | "yellow" | "red" {
  if (price < entry) return "green";
  if (price >= exit) return "red";
  return "yellow";
}

function shortQuestion(question: string, max = 62): string {
  return question.length > max ? `${question.slice(0, max - 1)}…` : question;
}

// =============================================================================
// FUNCTION BUAT NGHITUNG POSITION SIZE PAKE KELLY (DARI BOT LAMA)
// =============================================================================
function calculatePositionSizeWithKelly(
  balance: number,
  probability: number,  // Probabilitas menang dari forecast (0-1)
  price: number,        // Harga YES saat ini
  mode: TradeMode
): number {
  // Pake Kelly dari bot lama lo
  const kellyPercent = calculateKellyPosition(probability, price, KELLY_FRACTION);
  
  // Kalo Kelly gagal atau hasilnya 0, pake fallback 5%
  let positionPct = kellyPercent;
  if (positionPct <= 0 || !isFinite(positionPct)) {
    positionPct = FALLBACK_POSITION_PCT;
    warn(`Kelly returned ${kellyPercent}, falling back to ${FALLBACK_POSITION_PCT * 100}%`);
  }
  
  // Batasin maksimum 15% dari balance (biar gak all-in)
  positionPct = Math.min(positionPct, 0.15);
  
  const minOrderUsd = mode === "execute" ? MIN_EXECUTE_ORDER_USD : MIN_PAPER_ORDER_USD;
  let positionSize = balance * positionPct;
  
  // Minimal order size
  if (positionSize < minOrderUsd) {
    positionSize = minOrderUsd;
  }
  
  return Number(positionSize.toFixed(2));
}

// =============================================================================
// FUNCTION BUAT NGE-CHECK EXIT (STOP LOSS + TAKE PROFIT + TRAILING)
// DARI BOT LAMA LO
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
  
  // Inisialisasi highestPrice kalo belum ada (buat trailing stop)
  if (pos.highestPrice === undefined) {
    pos.highestPrice = entryPrice;
  }
  
  // Update highest price kalo harga lagi naik
  if (currentPrice > pos.highestPrice) {
    pos.highestPrice = currentPrice;
  }
  
  // CEK STOP LOSS (20% dari entry price)
  if (isStopLossHit(entryPrice, currentPrice)) {
    const loss = (currentPrice - entryPrice) * pos.shares;
    console.log(
      panel(
        `🛑 STOP LOSS • ${shortQuestion(pos.question, 56)}`,
        [
          stat("Entry price", `$${entryPrice.toFixed(3)}`, "cyan"),
          stat("Stop price", `$${calculateStopLoss(entryPrice).toFixed(3)}`, "red"),
          stat("Current price", `$${currentPrice.toFixed(3)}`, "red"),
          stat("Loss", `-$${Math.abs(loss).toFixed(2)}`, "red"),
          `${C.DIM("Stop reason")}   Price dropped ${STOP_LOSS_PCT * 100}% from entry`
        ],
        "red"
      )
    );
    
    // Eksekusi jual (paper atau live)
    if (mode === "execute" && clob && pos.token_id) {
      try {
        const sellPx = Math.max(currentPrice - 0.01, 0.01);
        await sellYesLimit(clob, pos.token_id, sellPx, pos.shares);
        ok("CLOB sell order submitted (stop loss)");
      } catch (e) {
        warn(`CLOB sell failed: ${String(e)}`);
        return false;
      }
    }
    
    // Update balance & state
    const exitPnl = (currentPrice - entryPrice) * pos.shares;
    balanceRef.value += pos.cost + exitPnl;
    if (exitPnl > 0) sim.wins += 1;
    else sim.losses += 1;
    
    const trade: Trade = {
      type: "exit",
      question: pos.question,
      entry_price: entryPrice,
      exit_price: currentPrice,
      pnl: Number(exitPnl.toFixed(2)),
      cost: pos.cost,
      closed_at: new Date().toISOString()
    };
    sim.trades.push(trade);
    delete positions[marketId];
    
    ok(`Stop loss closed — PnL: ${exitPnl >= 0 ? "+" : ""}${exitPnl.toFixed(2)}`);
    return true;
  }
  
  // CEK TRAILING STOP (DARI BOT LAMA LO)
  // Aktif kalo udah profit 20% dari entry
  if (currentPrice >= entryPrice * (1 + TRAILING_ACTIVATE_PCT)) {
    const newStop = updateTrailingStop(entryPrice, currentPrice, pos.highestPrice!);
    if (newStop !== null && currentPrice <= newStop) {
      const profit = (currentPrice - entryPrice) * pos.shares;
      console.log(
        panel(
          `🎯 TRAILING STOP • ${shortQuestion(pos.question, 56)}`,
          [
            stat("Entry price", `$${entryPrice.toFixed(3)}`, "cyan"),
            stat("Peak price", `$${pos.highestPrice!.toFixed(3)}`, "green"),
            stat("Exit price", `$${currentPrice.toFixed(3)}`, "yellow"),
            stat("Profit", `+$${profit.toFixed(2)}`, "green"),
            `${C.DIM("Stop reason")}   Trailing from peak (15% retracement)`
          ],
          "green"
        )
      );
      
      if (mode === "execute" && clob && pos.token_id) {
        try {
          const sellPx = Math.max(currentPrice - 0.01, 0.01);
          await sellYesLimit(clob, pos.token_id, sellPx, pos.shares);
          ok("CLOB sell order submitted (trailing stop)");
        } catch (e) {
          warn(`CLOB sell failed: ${String(e)}`);
          return false;
        }
      }
      
      balanceRef.value += pos.cost + profit;
      sim.wins += 1;
      const trade: Trade = {
        type: "exit",
        question: pos.question,
        entry_price: entryPrice,
        exit_price: currentPrice,
        pnl: Number(profit.toFixed(2)),
        cost: pos.cost,
        closed_at: new Date().toISOString()
      };
      sim.trades.push(trade);
      delete positions[marketId];
      
      ok(`Trailing stop closed — Profit: +$${profit.toFixed(2)}`);
      return true;
    }
  }
  
  return false; // Belum kena exit
}

// =============================================================================
// SHOW POSITIONS (UDH MODIF NAMPILIN TRAILING & STOP)
// =============================================================================
export async function showPositions(): Promise<void> {
  const sim = await loadSim();
  const positions = sim.positions;
  console.log(
    "\n" +
      panel(
        "Open Positions",
        [
          stat("Virtual balance", `$${sim.balance.toFixed(2)}`, "cyan"),
          stat("Open positions", `${Object.keys(positions).length}`, "blue"),
          stat("Trades", `${sim.total_trades}`, "magenta"),
          stat("W/L", `${sim.wins}/${sim.losses}`, "yellow")
        ],
        "blue"
      )
  );
  const mids = Object.keys(positions);
  if (!mids.length) {
    console.log(panel("Portfolio Status", [C.GRAY("No open positions right now.")], "gray"));
    return;
  }

  let totalPnl = 0;
  let totalUnrealizedPnl = 0;
  
  for (const mid of mids) {
    const pos = positions[mid] as PositionWithTracker;
    const currentPrice = (await getMarketYesPrice(mid)) ?? pos.entry_price ?? 0;
    const unrealizedPnl = (currentPrice - pos.entry_price) * pos.shares;
    totalUnrealizedPnl += unrealizedPnl;
    totalPnl += pos.pnl || 0;
    
    const pnlStr = unrealizedPnl >= 0
      ? C.GREEN(`+$${unrealizedPnl.toFixed(2)}`)
      : C.RED(`-$${Math.abs(unrealizedPnl).toFixed(2)}`);
    const tone = unrealizedPnl >= 0 ? "green" : "red";
    const stopPrice = calculateStopLoss(pos.entry_price);
    
    // Tampilin stop loss & trailing info
    let riskInfo = stat("Stop loss", `$${stopPrice.toFixed(3)} (${STOP_LOSS_PCT * 100}%)`, "yellow");
    if (pos.highestPrice && currentPrice >= pos.entry_price * 1.20) {
      riskInfo = stat("Trailing active", `Peak: $${pos.highestPrice.toFixed(3)}`, "green");
    }
    
    console.log(
      "\n" +
        panel(
          shortQuestion(pos.question, 68),
          [
            stat("Entry", `$${pos.entry_price.toFixed(3)}`, "cyan"),
            stat("Now", `$${currentPrice.toFixed(3)}`, tone),
            riskInfo,
            stat("Shares", pos.shares.toFixed(1), "blue"),
            stat("Cost", `$${pos.cost.toFixed(2)}`, "yellow"),
            stat("PnL", pnlStr, tone),
            `${C.DIM("Market odds")}   ${progressBar(currentPrice, 1, 26, tone)}`
          ],
          tone
        )
    );
  }

  const totalColor = totalUnrealizedPnl >= 0 ? C.GREEN : C.RED;
  console.log(
    "\n" +
      panel(
        "Portfolio Summary",
        [
          stat("Balance", `$${sim.balance.toFixed(2)}`, "cyan"),
          stat("Unrealized PnL", totalColor(`${totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}`), totalUnrealizedPnl >= 0 ? "green" : "red"),
          stat("Realized PnL", `$${totalPnl.toFixed(2)}`, totalPnl >= 0 ? "green" : "red"),
          stat("Total trades", `${sim.total_trades}`, "blue"),
          stat("W/L", `${sim.wins}/${sim.losses}`, "yellow")
        ],
        totalUnrealizedPnl >= 0 ? "green" : "red"
      )
  );
}

// =============================================================================
// MAIN RUN FUNCTION (MODIF DENGAN KELLY + STOP LOSS)
// =============================================================================
export async function run(options: RunOptions): Promise<void> {
  const { mode, config } = options;

  const sim = await loadSim();
  const walletUsd = options.walletUsd;

  let balance: number =
    mode === "execute" && walletUsd != null && Number.isFinite(walletUsd)
      ? walletUsd
      : sim.balance;

  const positions = sim.positions as Record<string, PositionWithTracker>;
  let tradesExecuted = 0;
  let exitsFound = 0;

  let clob: ClobClient | undefined;
  if (mode === "execute") {
    try {
      clob = await getClobClient(config);
    } catch (e) {
      warn(`Failed to init CLOB client: ${String(e)}`);
      return;
    }
  }

  const starting = sim.starting_balance;
  const totalReturn = ((balance - starting) / starting) * 100;
  const returnStr =
    totalReturn >= 0
      ? C.GREEN(`+${totalReturn.toFixed(1)}%`)
      : C.RED(`${totalReturn.toFixed(1)}%`);

  console.log(
    "\n" +
      panel(
        "Weather Trading Bot (UPGRADED with Kelly + Stop Loss)",
        [
          `${badge(modeText(mode), modeTone(mode))} ${C.DIM("Automated weather-market scanner")}`,
          "",
          stat(mode === "execute" ? "Wallet" : "Virtual balance", `$${balance.toFixed(2)}`, "cyan"),
          ...(mode !== "execute"
            ? [stat("Return vs start", `${returnStr}  ${C.DIM(`from $${starting.toFixed(2)}`)}`, totalReturn >= 0 ? "green" : "red")]
            : []),
          stat("Position sizing", `${KELLY_FRACTION * 100}% Kelly (max 15%)`, "blue"),
          stat("Stop loss", `${STOP_LOSS_PCT * 100}% from entry`, "red"),
          stat("Entry threshold", `< $${config.entry_threshold.toFixed(2)}`, "green"),
          stat("Exit threshold", `>= $${config.exit_threshold.toFixed(2)} (or stop loss)`, "red"),
          stat("Trade record", `${sim.wins} wins / ${sim.losses} losses`, "yellow")
        ],
        modeTone(mode)
      )
  );

  const persist = mode === "paper" || mode === "execute";
  const balanceRef = { value: balance };

  // --- CHECK EXITS (with Stop Loss & Trailing) ---
  console.log(`\n${divider("EXIT SCAN (Stop Loss / Take Profit / Trailing)", "magenta")}`);
  for (const [mid, pos] of Object.entries(positions)) {
    const currentPrice = await getMarketYesPrice(mid);
    if (currentPrice == null) continue;

    // Check if price hit take profit (original exit threshold)
    if (currentPrice >= config.exit_threshold) {
      exitsFound += 1;
      const profit = (currentPrice - pos.entry_price) * pos.shares;
      console.log(
        panel(
          `Take Profit • ${shortQuestion(pos.question, 56)}`,
          [
            stat("Current price", `$${currentPrice.toFixed(3)}`, "green"),
            stat("Exit threshold", `$${config.exit_threshold.toFixed(2)}`, "yellow"),
            stat("Shares", pos.shares.toFixed(1), "blue"),
            stat("Profit", `+$${profit.toFixed(2)}`, "green"),
            `${C.DIM("Odds gauge")}     ${progressBar(currentPrice, 1, 26, "green")}`
          ],
          "green"
        )
      );

      if (mode === "execute" && clob && pos.token_id) {
        try {
          const sellPx = Math.max(currentPrice - 0.01, 0.01);
          await sellYesLimit(clob, pos.token_id, sellPx, pos.shares);
          ok("CLOB sell order submitted");
        } catch (e) {
          warn(`CLOB sell failed: ${String(e)}`);
          continue;
        }
      }
      
      balanceRef.value += pos.cost + profit;
      if (profit > 0) sim.wins += 1;
      else sim.losses += 1;
      const trade: Trade = {
        type: "exit",
        question: pos.question,
        entry_price: pos.entry_price,
        exit_price: currentPrice,
        pnl: Number(profit.toFixed(2)),
        cost: pos.cost,
        closed_at: new Date().toISOString()
      };
      sim.trades.push(trade);
      delete positions[mid];
      ok(`Closed — PnL: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}`);
      continue;
    }
    
    // Check Stop Loss & Trailing (NEW from bot lama)
    const exited = await checkAndExecuteExit(
      mid, pos, currentPrice, mode, clob, balanceRef, sim, positions
    );
    if (exited) {
      exitsFound += 1;
    }
  }

  if (exitsFound === 0) {
    skip("No exit opportunities");
  }

  // --- SCAN ENTRIES (with Kelly sizing) ---
  console.log(`\n${divider("ENTRY SCAN (with Kelly sizing)", "cyan")}`);

  const activeLocations = getActiveLocations(config);
  for (const citySlug of activeLocations) {
    if (!(citySlug in LOCATIONS)) {
      continue;
    }

    const locData = LOCATIONS[citySlug];
    const forecast: DailyForecast = await getForecast(citySlug);
    if (!forecast || Object.keys(forecast).length === 0) continue;

    for (let i = 0; i < 4; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().slice(0, 10);
      const month = MONTHS[date.getMonth()];
      const day = date.getDate();
      const year = date.getFullYear();

      const forecastTemp = forecast[dateStr];
      if (forecastTemp == null) continue;

      const event: PolymarketEvent | null = await getPolymarketEvent(
        citySlug,
        month,
        day,
        year
      );
      if (!event) continue;

      const hoursLeft = hoursUntilResolution(event);
      console.log(
        "\n" +
          panel(
            `${locData.name} • ${dateStr}`,
            [
              stat("Forecast max", `${forecastTemp}°F`, "cyan"),
              stat("Resolves in", `${hoursLeft.toFixed(0)}h`, hoursLeft < config.min_hours_to_resolution ? "red" : "green"),
              stat("Market date", `${month} ${day}, ${year}`, "blue")
            ],
            "blue"
          )
      );

      if (hoursLeft < config.min_hours_to_resolution) {
        skip(`Resolves in ${hoursLeft.toFixed(0)}h — too soon`);
        continue;
      }

      let matched:
        | {
            market: PolymarketMarket;
            question: string;
            price: number;
            range: [number, number];
          }
        | null = null;

      for (const market of event.markets ?? []) {
        const question = market.question ?? "";
        const rng = parseTempRange(question);
        if (rng && rng[0] <= forecastTemp && forecastTemp <= rng[1]) {
          try {
            const pricesStr = market.outcomePrices ?? "[0.5,0.5]";
            const prices = JSON.parse(pricesStr) as number[];
            const yesPrice = Number(prices[0]);
            if (!isFinite(yesPrice)) continue;
            matched = {
              market,
              question,
              price: yesPrice,
              range: rng
            };
          } catch {
            continue;
          }
          break;
        }
      }

      if (!matched) {
        skip(`No bucket found for ${forecastTemp}°F`);
        continue;
      }

      const price = matched.price;
      const marketId = matched.market.id;
      const question = matched.question;
      const tone = priceTone(price, config.entry_threshold, config.exit_threshold);
      
      console.log(
        panel(
          `Matched Bucket • ${shortQuestion(question, 52)}`,
          [
            stat("Forecast temp", `${forecastTemp}°F`, "cyan"),
            stat("YES price", `$${price.toFixed(3)}`, tone),
            stat("Entry trigger", `< $${config.entry_threshold.toFixed(2)}`, "green"),
            stat("Exit trigger", `$${config.exit_threshold.toFixed(2)} or stop loss`, "red"),
            `${C.DIM("Market odds")}   ${progressBar(price, 1, 26, tone)}`
          ],
          tone
        )
      );

      if (price >= config.entry_threshold) {
        skip(
          `Price $${price.toFixed(3)} above threshold $${config.entry_threshold.toFixed(2)}`
        );
        continue;
      }

      // ============================================================
      // 🚀 UPGRADE: PAKE KELLY CRITERION BUAT SIZING (DARI BOT LAMA)
      // ============================================================
      // Estimate probability (simple version: price inverse)
      // Kalo lo punya ensemble forecast, ini bisa diganti dengan probabilitas real
      const estimatedProb = Math.min(0.95, Math.max(0.05, 1 - price));
      
      const positionSize = calculatePositionSizeWithKelly(
        balanceRef.value,
        estimatedProb,
        price,
        mode
      );

      if (balanceRef.value < MIN_PAPER_ORDER_USD) {
        skip(
          `Wallet balance $${balanceRef.value.toFixed(2)} is below minimum order size`
        );
        continue;
      }

      const shares = positionSize / price;
      const kellyPercentDisplay = ((positionSize / balanceRef.value) * 100).toFixed(1);
      
      console.log(
        panel(
          `Entry Signal • ${locData.name}`,
          [
            stat("Action", `${mode === "execute" ? "BUY YES" : "BUY SETUP"}`, "green"),
            stat("Price", `$${price.toFixed(3)}`, "green"),
            stat("Position size", `$${positionSize.toFixed(2)} (${kellyPercentDisplay}% of balance)`, "yellow"),
            stat("Estimated shares", shares.toFixed(1), "blue"),
            stat("Stop loss", `$${(price * (1 - STOP_LOSS_PCT)).toFixed(3)} (${STOP_LOSS_PCT * 100}%)`, "yellow"),
            `${C.DIM("Sizing method")} ${KELLY_FRACTION * 100}% Kelly (base ${FALLBACK_POSITION_PCT * 100}%)`
          ],
          "green"
        )
      );

      if (positions[marketId]) {
        skip("Already in this market");
        continue;
      }

      if (tradesExecuted >= config.max_trades_per_run) {
        skip(`Max trades (${config.max_trades_per_run}) reached`);
        continue;
      }

      if (positionSize < MIN_PAPER_ORDER_USD) {
        skip(`Position size $${positionSize.toFixed(2)} too small`);
        continue;
      }

      if (mode === "execute") {
        const tokenId = getYesTokenId(matched.market);
        if (!tokenId || !clob) {
          warn("No clobTokenIds on market — cannot trade this market on CLOB");
          continue;
        }
        const limitPx = Math.min(price + 0.03, 0.99);
        try {
          await buyYesLimit(clob, tokenId, limitPx, shares);
          ok(`CLOB buy order submitted @ limit $${limitPx.toFixed(3)}`);
        } catch (e) {
          warn(`CLOB buy failed: ${String(e)}`);
          continue;
        }
        const pos: PositionWithTracker = {
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          date: dateStr,
          location: citySlug,
          forecast_temp: forecastTemp,
          opened_at: new Date().toISOString(),
          token_id: tokenId,
          highestPrice: price  // Inisialisasi highest price untuk trailing stop
        };
        positions[marketId] = pos;
        sim.total_trades += 1;
        const trade: Trade = {
          type: "entry",
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          opened_at: pos.opened_at
        };
        sim.trades.push(trade);
        tradesExecuted += 1;
        balanceRef.value -= positionSize;
      } else if (mode === "paper") {
        balanceRef.value -= positionSize;
        const pos: PositionWithTracker = {
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          date: dateStr,
          location: citySlug,
          forecast_temp: forecastTemp,
          opened_at: new Date().toISOString(),
          highestPrice: price  // Inisialisasi highest price untuk trailing stop
        };
        positions[marketId] = pos;
        sim.total_trades += 1;
        const trade: Trade = {
          type: "entry",
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          opened_at: pos.opened_at
        };
        sim.trades.push(trade);
        tradesExecuted += 1;
        ok(
          `Position opened — $${positionSize.toFixed(2)} deducted from balance (${kellyPercentDisplay}% of balance)`
        );
      } else {
        skip("Dry-run — not buying");
        tradesExecuted += 1;
      }
    }
  }

  if (persist) {
    sim.balance = Number(balanceRef.value.toFixed(2));
    sim.positions = positions;
    sim.peak_balance = Math.max(sim.peak_balance ?? balanceRef.value, balanceRef.value);
    await saveSim(sim);
  }

  console.log(
    "\n" +
      panel(
        "Run Summary",
        [
          stat("Ending balance", `$${balanceRef.value.toFixed(2)}`, "cyan"),
          stat("Trades this run", `${tradesExecuted}`, tradesExecuted > 0 ? "green" : "gray"),
          stat("Exits found", `${exitsFound}`, exitsFound > 0 ? "magenta" : "gray"),
          stat("Open positions", `${Object.keys(positions).length}`, "blue"),
          `${C.DIM("Bot mode")}       ${badge(modeText(mode), modeTone(mode))}`,
          `${C.DIM("Risk mgmt")}     Kelly ${KELLY_FRACTION * 100}% | Stop loss ${STOP_LOSS_PCT * 100}% | Trailing active`
        ],
        modeTone(mode)
      )
  );

  if (mode === "dry-run") {
    console.log(
      "\n" +
        panel(
          "Dry-Run Reminder",
          [
            C.YELLOW("No orders were submitted in this run."),
            "Use `npm run paper` for paper trading or `npm run execute` for real CLOB orders."
          ],
          "yellow"
        )
    );
  }
}
