// src/depth.ts - VERSI UPGRADE (Step 2)
// Fix liquidity, spread filter, volume filter
import axios from 'axios';

const CLOB_API = 'https://clob.polymarket.com';

export interface OrderBook {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
}

export async function getOrderBook(tokenId: string): Promise<OrderBook | null> {
  try {
    const url = `${CLOB_API}/book?token_id=${tokenId}`;
    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;
    
    return {
      bids: (data.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      asks: (data.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    };
  } catch (error) {
    console.error(`[Depth] Failed to fetch order book: ${error}`);
    return null;
  }
}

export async function getBestBidAsk(tokenId: string): Promise<{ bid: number; ask: number; bidSize: number; askSize: number; spread: number } | null> {
  const book = await getOrderBook(tokenId);
  if (!book || !book.bids.length || !book.asks.length) return null;
  
  const bid = book.bids[0]?.price || 0;
  const ask = book.asks[0]?.price || 0;
  const spread = (ask - bid) / ((ask + bid) / 2);
  
  // SPREAD FILTER: kalo spread > 4%, reject
  if (spread > 0.04) {
    console.log(`[Depth] Spread too high: ${(spread * 100).toFixed(2)}%`);
    return null;
  }
  
  return {
    bid,
    ask,
    bidSize: book.bids[0]?.size || 0,
    askSize: book.asks[0]?.size || 0,
    spread
  };
}

export async function isLiquidEnough(tokenId: string, requiredShares: number, slippagePercent: number = 5): Promise<boolean> {
  const book = await getOrderBook(tokenId);
  if (!book || !book.asks.length) return false;
  
  const maxPrice = book.asks[0]?.price * (1 + slippagePercent / 100);
  let availableShares = 0;
  let totalCost = 0;
  
  for (const ask of book.asks) {
    if (ask.price > maxPrice) break;
    const remainingNeeded = requiredShares - availableShares;
    const takeShares = Math.min(ask.size, remainingNeeded);
    availableShares += takeShares;
    totalCost += takeShares * ask.price;
    if (availableShares >= requiredShares) break;
  }
  
  const avgPrice = availableShares >= requiredShares ? totalCost / requiredShares : book.asks[0]?.price;
  const slippage = avgPrice ? ((avgPrice - book.asks[0]?.price) / book.asks[0]?.price) * 100 : 0;
  
  console.log(`[Depth] Required: ${requiredShares.toFixed(1)}, Available: ${availableShares.toFixed(1)}, Slippage: ${slippage.toFixed(2)}%`);
  
  // FIX: return true only if sufficient shares AND slippage <= 5%
  return (availableShares >= requiredShares && slippage <= 5);
}

export async function getMarketVolume(tokenId: string): Promise<{ volume24h: number; volume7d: number }> {
  try {
    const url = `${CLOB_API}/markets/${tokenId}/volume`;
    const response = await axios.get(url, { timeout: 5000 });
    return {
      volume24h: response.data?.volume_24h || 0,
      volume7d: response.data?.volume_7d || 0
    };
  } catch {
    return { volume24h: 0, volume7d: 0 };
  }
}
