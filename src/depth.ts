// src/depth.ts - Order Book Depth Check (Anti-Slippage)
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

export async function getBestBidAsk(tokenId: string): Promise<{ bid: number; ask: number; bidSize: number; askSize: number } | null> {
  const book = await getOrderBook(tokenId);
  if (!book) return null;
  
  return {
    bid: book.bids[0]?.price || 0,
    ask: book.asks[0]?.price || 0,
    bidSize: book.bids[0]?.size || 0,
    askSize: book.asks[0]?.size || 0
  };
}

export async function isLiquidEnough(tokenId: string, requiredShares: number, slippagePercent: number = 10): Promise<boolean> {
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
  
  return availableShares >= requiredShares;
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
