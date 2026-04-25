// src/risk.ts - VERSI UPGRADE (Step 1)
// MAX_POSITION_PCT 0.15→0.05, MIN_EV 0.05→0.08, trail 0.85→0.92

const KELLY_FRACTION = 0.25;
const STOP_LOSS_PCT = 0.15;           // 20% → 15%
const TRAILING_ACTIVATE_PCT = 0.15;    // 20% → 15%
const TRAILING_RETRACE_PCT = 0.92;     // 0.85 → 0.92 (trail 8% dari peak)
const MAX_POSITION_PCT = 0.05;         // 0.15 → 0.05 (cap 5% per trade)
const MIN_EV = 0.08;                   // 0.05 → 0.08 (EV 8%)

/**
 * Hitung Expected Value (EV)
 */
export function calculateExpectedValue(prob: number, price: number): number {
    if (price <= 0 || price >= 1) return 0;
    const potentialProfit = (1 / price) - 1;
    return (prob * potentialProfit) - ((1 - prob) * 1);
}

/**
 * Cek apakah EV memenuhi minimum threshold
 */
export function isEVSufficient(prob: number, price: number): boolean {
    return calculateExpectedValue(prob, price) >= MIN_EV;
}

/**
 * Hitung ukuran posisi pake Fractional Kelly
 */
export function calculateKellyPosition(prob: number, price: number): number {
    if (price <= 0 || price >= 1) return 0;
    
    const b = (1 / price) - 1;
    const q = 1 - prob;
    const kellyValue = (prob * b - q) / b;
    
    if (kellyValue <= 0) return 0;
    
    const finalValue = kellyValue * KELLY_FRACTION;
    return Math.min(finalValue, MAX_POSITION_PCT);
}

/**
 * Hitung harga Stop Loss (15% di bawah harga beli)
 */
export function calculateStopLoss(entryPrice: number): number {
    return entryPrice * (1 - STOP_LOSS_PCT);
}

/**
 * Cek apakah kena Stop Loss
 */
export function isStopLossHit(entryPrice: number, currentPrice: number): boolean {
    return currentPrice <= calculateStopLoss(entryPrice);
}

/**
 * Hitung harga Trailing Stop (trail 8% dari peak)
 */
export function updateTrailingStop(entryPrice: number, currentPrice: number, highestPrice: number): number | null {
    const activateThreshold = entryPrice * (1 + TRAILING_ACTIVATE_PCT);
    
    if (currentPrice >= activateThreshold) {
        const newStop = highestPrice * TRAILING_RETRACE_PCT;
        return Math.max(newStop, entryPrice);
    }
    return null;
}

/**
 * Adjust position size based on losing streak (drawdown throttle)
 */
export function adjustForDrawdown(baseSize: number, losingStreak: number): number {
    if (losingStreak >= 5) {
        return baseSize * 0.5;  // Cut posisi 50% kalo loss 5x berturut
    }
    if (losingStreak >= 10) {
        return 0;  // Stop trading kalo loss 10x
    }
    return baseSize;
}
