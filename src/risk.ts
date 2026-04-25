// src/risk.ts - VERSI FINAL (tanpa parameter config)
// Parameter hardcoded sesuai bot lama lo

const KELLY_FRACTION = 0.25;        // Fractional Kelly (25% dari full Kelly)
const STOP_LOSS_PCT = 0.20;          // Stop loss 20% dari entry
const TRAILING_ACTIVATE_PCT = 0.20;   // Aktifin trailing setelah profit 20%
const MAX_POSITION_PCT = 0.15;        // Maksimum posisi 15% dari balance
const MIN_EV = 0.05;                  // Minimum Expected Value 5%

/**
 * Hitung Expected Value (EV)
 * EV = p * (1/price - 1) - (1-p)
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
 * Rumus: f* = (p * b - q) / b, lalu dikali KELLY_FRACTION
 */
export function calculateKellyPosition(prob: number, price: number): number {
    if (price <= 0 || price >= 1) return 0;
    
    const b = (1 / price) - 1;  // Odds: berapa kali lipat keuntungan kalo menang
    const q = 1 - prob;          // Probabilitas kalah
    
    const kellyValue = (prob * b - q) / b;
    
    // Kalo negatif, gak usah beli
    if (kellyValue <= 0) return 0;
    
    // Fractional Kelly + batasin maksimum
    const finalValue = kellyValue * KELLY_FRACTION;
    return Math.min(finalValue, MAX_POSITION_PCT);
}

/**
 * Hitung harga Stop Loss (20% di bawah harga beli)
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
 * Hitung harga Trailing Stop
 * @param entryPrice Harga beli awal
 * @param currentPrice Harga saat ini
 * @param highestPrice Harga tertinggi yang pernah tercapai
 * @returns Harga stop loss baru, atau null kalo belum waktunya
 */
export function updateTrailingStop(entryPrice: number, currentPrice: number, highestPrice: number): number | null {
    const activateThreshold = entryPrice * (1 + TRAILING_ACTIVATE_PCT);
    
    // Cek apakah sudah waktunya trailing stop aktif (profit >=20%)
    if (currentPrice >= activateThreshold) {
        // Trail 15% dari harga tertinggi (85% dari peak)
        const trailPct = 0.85;
        const newStop = highestPrice * trailPct;
        // Stop loss tidak boleh lebih rendah dari harga beli (break even)
        return Math.max(newStop, entryPrice);
    }
    return null;
}
