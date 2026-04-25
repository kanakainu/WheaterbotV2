// src/arbitrage.ts - DUAL-SIDE ARBITRAGE SCANNER (WEEK 2)
import { getPolymarketEvent } from "./polymarket";
import { parseTempRange } from "./parsing";
import { MONTHS } from "./time";
import { stat, panel, C, divider } from "./colors";

export interface ArbitrageOpportunity {
  eventId: string;
  city: string;
  date: string;
  yesPrice: number;
  noPrice: number;
  totalPrice: number;
  arbEdge: number;
  profitPercent: number;
  sharesYes: number;
  sharesNo: number;
  cost: number;
}

export function checkArbitrage(yesPrice: number, noPrice: number): ArbitrageOpportunity | null {
  const totalPrice = yesPrice + noPrice;
  const arbEdge = 1 - totalPrice;
  
  if (arbEdge <= 0.02) return null;
  
  const targetNotional = 100;
  const sharesYes = targetNotional / yesPrice;
  const sharesNo = targetNotional / noPrice;
  const cost = sharesYes * yesPrice + sharesNo * noPrice;
  const profitPercent = ((targetNotional - cost) / cost) * 100;
  
  return {
    eventId: '',
    city: '',
    date: '',
    yesPrice,
    noPrice,
    totalPrice,
    arbEdge,
    profitPercent,
    sharesYes,
    sharesNo,
    cost
  };
}

export async function scanArbitrage(
  citySlug: string,
  month: string,
  day: number,
  year: number
): Promise<ArbitrageOpportunity | null> {
  const event = await getPolymarketEvent(citySlug, month, day, year);
  if (!event) return null;
  
  let yesPrice: number | null = null;
  let noPrice: number | null = null;
  
  for (const market of event.markets ?? []) {
    const question = market.question ?? "";
    const rng = parseTempRange(question);
    if (!rng) continue;
    
    try {
      const pricesStr = market.outcomePrices ?? "[0.5,0.5]";
      const prices = JSON.parse(pricesStr) as number[];
      const yes = Number(prices[0]);
      const no = Number(prices[1]);
      
      if (isNaN(yes) || isNaN(no)) continue;
      
      if (rng[0] === -999 || rng[1] === 999) {
        yesPrice = yes;
        noPrice = no;
      } else {
        yesPrice = yes;
        noPrice = no;
      }
      break;
    } catch {
      continue;
    }
  }
  
  if (yesPrice === null || noPrice === null) return null;
  
  const arb = checkArbitrage(yesPrice, noPrice);
  if (arb) {
    arb.eventId = event.id;
    arb.city = citySlug;
    arb.date = `${month} ${day}, ${year}`;
  }
  
  return arb;
}

export async function runArbitrageScanner(locations: string[]): Promise<void> {
  console.log("\n" + panel("🔍 ARBITRAGE SCANNER", [
    "Scanning for risk-free opportunities (YES + NO < 1)..."
  ], "cyan"));
  
  const opportunities: ArbitrageOpportunity[] = [];
  const today = new Date();
  
  console.log(divider("SCANNING", "cyan"));
  
  for (const citySlug of locations) {
    for (let i = 0; i < 4; i++) {
      const date = new Date();
      date.setDate(today.getDate() + i);
      const month = MONTHS[date.getMonth()];
      const day = date.getDate();
      const year = date.getFullYear();
      
      const arb = await scanArbitrage(citySlug, month, day, year);
      if (arb) {
        opportunities.push(arb);
        console.log(stat(`${citySlug} ${month} ${day}`, 
          `YES ${(arb.yesPrice*100).toFixed(1)}% + NO ${(arb.noPrice*100).toFixed(1)}% = ${(arb.totalPrice*100).toFixed(1)}% | Profit: ${arb.profitPercent.toFixed(2)}%`, 
          "green"));
      }
    }
  }
  
  console.log(divider("RESULTS", "cyan"));
  
  if (opportunities.length === 0) {
    console.log(C.DIM("  No arbitrage opportunities found."));
  } else {
    console.log(`\n  Found ${opportunities.length} opportunity(ies):`);
    for (const opp of opportunities) {
      console.log(`  📍 ${opp.city} ${opp.date}: ${opp.profitPercent.toFixed(2)}% risk-free profit`);
    }
  }
  
  console.log(C.DIM("\n  Note: Arbitrage requires holding both YES and NO until resolution.\n"));
}
