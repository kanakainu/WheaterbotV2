// src/risk.ts - CONFIDENCE KELLY + DRAWDOWN PROTECTION

const KELLY_FRACTION = 0.20;           // 20% dari full Kelly (lebih konservatif)
const MAX_POSITION_PCT = 0.03;          // Max 3% per trade (dari 5%)
const STOP_LOSS_PCT = 0.15;
const TRAILING_ACTIVATE_PCT = 0.15;
const TRAILING_RETRACE_PCT = 0.92;
const MIN_EV = 0.08;

// ========== NEW: CONFIDENCE KELLY ==========
export function getPositionSize(
  prob: number,           // Model probability (0-1)
  price: number,          // Market price
  confidence: number,     // Model confidence (0-1)
  losingStreak: number    // Current losing streak count
): number {
  // Full Kelly formula
  const b = (1 / price) - 1;
  const q = 1 - prob;
  let kelly = ((prob * b) - q) / b;
  
  if (kelly <= 0 || !isFinite(kelly)) return 0;
  
  // 1. CONFIDENCE HAIRCUT
  kelly *= confidence;
  
  // 2. DRAWDOWN PROTECTION
  if (losingStreak >= 2) kelly *= 0.5;    // Cut size 50% after 2 losses
  if (losingStreak >= 4) return 0;        // No new trades after 4 losses
  
  // 3. FRACTIONAL KELLY
  kelly *= KELLY_FRACTION;
  
  // 4. CAP MAX POSITION
  return Math.min(kelly, MAX_POSITION_PCT);
}

// ========== LEGACY FUNCTIONS (untuk kompatibilitas) ==========
export function calculateExpectedValue(prob: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  const potentialProfit = (1 / price) - 1;
  return (prob * potentialProfit) - ((1 - prob) * 1);
}

export function isEVSufficient(prob: number, price: number): boolean {
  return calculateExpectedValue(prob, price) >= MIN_EV;
}

export function calculateKellyPosition(prob: number, price: number): number {
  const b = (1 / price) - 1;
  const q = 1 - prob;
  const kelly = ((prob * b) - q) / b;
  if (kelly <= 0) return 0;
  return Math.min(kelly * KELLY_FRACTION, MAX_POSITION_PCT);
}

export function calculateStopLoss(entryPrice: number): number {
  return entryPrice * (1 - STOP_LOSS_PCT);
}

export function isStopLossHit(entryPrice: number, currentPrice: number): boolean {
  return currentPrice <= calculateStopLoss(entryPrice);
}

export function updateTrailingStop(entryPrice: number, currentPrice: number, highestPrice: number): number | null {
  const activateThreshold = entryPrice * (1 + TRAILING_ACTIVATE_PCT);
  if (currentPrice >= activateThreshold) {
    const newStop = highestPrice * TRAILING_RETRACE_PCT;
    return Math.max(newStop, entryPrice);
  }
  return null;
}

// Simpler adjust function for compatibility
export function adjustForDrawdown(size: number, losingStreak: number): number {
  if (losingStreak >= 4) return 0;
  if (losingStreak >= 2) return size * 0.5;
  return size;
}
