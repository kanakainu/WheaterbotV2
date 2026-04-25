// src/risk.ts - VERSI FINAL (siap pakai)

const KELLY_FRACTION = 0.25;
const STOP_LOSS_PCT = 0.20;
const TRAILING_ACTIVATE_PCT = 0.20;
const MAX_POSITION_PCT = 0.15;
const MIN_EV = 0.05;

export function calculateExpectedValue(prob: number, price: number): number {
    if (price <= 0 || price >= 1) return 0;
    const potentialProfit = (1 / price) - 1;
    return (prob * potentialProfit) - ((1 - prob) * 1);
}

export function isEVSufficient(prob: number, price: number): boolean {
    return calculateExpectedValue(prob, price) >= MIN_EV;
}

export function calculateKellyPosition(prob: number, price: number): number {
    if (price <= 0 || price >= 1) return 0;
    const b = (1 / price) - 1;
    const q = 1 - prob;
    const kellyValue = (prob * b - q) / b;
    if (kellyValue <= 0) return 0;
    const finalValue = kellyValue * KELLY_FRACTION;
    return Math.min(finalValue, MAX_POSITION_PCT);
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
        const newStop = highestPrice * 0.85;
        return Math.max(newStop, entryPrice);
    }
    return null;
}
