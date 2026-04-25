// src/market-maker.ts - WEEK 4 (Auto Quote Engine + Inventory Control)
import { getBestBidAsk, getOrderBook } from "./depth";
import { getYesTokenId } from "./polymarket";
import type { ClobClient } from "@polymarket/clob-client";
import { buyYesLimit, sellYesLimit } from "./clob";

export interface MarketMakerConfig {
  fairPrice: number;           // Estimated fair price
  spreadBuffer: number;        // Spread buffer (0.02 = 2%)
  maxInventory: number;        // Max position size in shares
  currentInventory: number;    // Current YES inventory
  quoteSize: number;           // Size per quote order
}

export interface Quote {
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
}

/**
 * Calculate fair price from edge and market price
 */
export function calculateFairPrice(marketPrice: number, edge: number): number {
  // If we have positive edge, fair price is higher
  return marketPrice + edge;
}

/**
 * Generate quotes based on inventory and fair price
 */
export function generateQuotes(config: MarketMakerConfig): Quote {
  const { fairPrice, spreadBuffer, maxInventory, currentInventory, quoteSize } = config;
  
  // Adjust quotes based on inventory
  let inventoryAdjustment = 0;
  if (currentInventory > maxInventory * 0.7) {
    // Too much YES inventory, lower bids, raise asks
    inventoryAdjustment = -0.01;
  } else if (currentInventory < maxInventory * 0.3) {
    // Need more YES inventory, raise bids, lower asks
    inventoryAdjustment = 0.01;
  }
  
  // Calculate bid and ask
  let bidPrice = fairPrice - spreadBuffer + inventoryAdjustment;
  let askPrice = fairPrice + spreadBuffer + inventoryAdjustment;
  
  // Ensure prices are within [0,1]
  bidPrice = Math.max(0.01, Math.min(0.99, bidPrice));
  askPrice = Math.max(0.01, Math.min(0.99, askPrice));
  
  // Adjust sizes based on inventory
  let bidSize = quoteSize;
  let askSize = quoteSize;
  
  if (currentInventory > maxInventory * 0.8) {
    askSize = quoteSize * 1.5;  // Offer more to sell
    bidSize = quoteSize * 0.5;  // Buy less
  } else if (currentInventory < maxInventory * 0.2) {
    bidSize = quoteSize * 1.5;  // Buy more
    askSize = quoteSize * 0.5;  // Sell less
  }
  
  return { bidPrice, askPrice, bidSize, askSize };
}

/**
 * Post limit orders to capture spread
 */
export async function postQuotes(
  clob: ClobClient,
  tokenId: string,
  quote: Quote,
  mode: 'live' | 'paper'
): Promise<void> {
  if (mode !== 'live') {
    console.log(`[MM] Paper quote: bid ${quote.bidPrice.toFixed(3)} x ${quote.bidSize}, ask ${quote.askPrice.toFixed(3)} x ${quote.askSize}`);
    return;
  }
  
  try {
    // Post bid order
    await buyYesLimit(clob, tokenId, quote.bidPrice, quote.bidSize);
    // Post ask order
    await sellYesLimit(clob, tokenId, quote.askPrice, quote.askSize);
    console.log(`[MM] Posted quotes: bid ${quote.bidPrice.toFixed(3)} x ${quote.bidSize}, ask ${quote.askPrice.toFixed(3)} x ${quote.askSize}`);
  } catch (error) {
    console.error(`[MM] Failed to post quotes: ${error}`);
  }
}

/**
 * Calculate spread capture profit
 */
export function calculateSpreadProfit(quote: Quote, filledBid: number, filledAsk: number): number {
  const bidFill = Math.min(quote.bidSize, filledBid);
  const askFill = Math.min(quote.askSize, filledAsk);
  const spreadProfit = (quote.askPrice - quote.bidPrice) * Math.min(bidFill, askFill);
  return spreadProfit;
}

/**
 * Check if market is suitable for market making
 */
export function isMarketMakable(spreadPercent: number, volume24h: number): boolean {
  // Need tight spread and decent volume
  return spreadPercent <= 0.03 && volume24h >= 10000;
}

/**
 * Scan for market making opportunities
 */
export async function scanMarketMakingOpportunities(
  tokenId: string,
  fairPrice: number,
  currentInventory: number,
  maxInventory: number
): Promise<Quote | null> {
  const bestBidAsk = await getBestBidAsk(tokenId);
  if (!bestBidAsk) return null;
  
  const currentSpread = bestBidAsk.spreadPercent;
  
  // Only quote if spread is wide enough to capture
  if (currentSpread < 0.01) return null;  // Spread too tight, no profit
  
  const optimalSpread = Math.max(0.01, currentSpread * 0.5);  // Quote half of current spread
  
  const config: MarketMakerConfig = {
    fairPrice,
    spreadBuffer: optimalSpread / 2,
    maxInventory,
    currentInventory,
    quoteSize: Math.min(100, maxInventory * 0.1)  // 10% of max per quote
  };
  
  return generateQuotes(config);
}
