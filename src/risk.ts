// src/risk.ts
// 📦 KOMBINASI DARI BOT LAMA (Python V2) - Kelly + Stop Loss + EV
import { BotConfig } from "./config";

/**
 * Hitung Expected Value (EV)
 * Rumus: EV = (Probabilitas Menang * Potensi Keuntungan) - (Probabilitas Kalah * Potensi Kerugian)
 * Potensi Keuntungan dihitung sebagai (1/price - 1)
 */
export function calculateExpectedValue(prob: number, price: number): number {
    if (price <= 0 || price >= 1) return 0;
    const potentialProfit = (1 / price) - 1;
    const potentialLoss = 1;
    return (prob * potentialProfit) - ((1 - prob) * potentialLoss);
}

/**
 * Cek apakah EV memenuhi minimum threshold dari config
 */
export function isEVSufficient(prob: number, price: number, config: BotConfig): boolean {
    const ev = calculateExpectedValue(prob, price);
    return ev >= config.min_ev;
}

/**
 * Hitung ukuran posisi pake Kelly Criterion (dari Bot Python V2 lo)
 * Rumus Kelly: f* = (p * b - q) / b
 * Di sini kita pake Fractional Kelly (p * kelly_fraction) biar lebih aman.
 */
export function calculateKellyPosition(
    prob: number,          // Probabilitas menang (0-1)
    price: number,        // Harga YES saat ini
    config: BotConfig      // Konfigurasi dari bot
): number {
    if (price <= 0 || price >= 1) return 0;
    if (!config.use_kelly) return config.max_position_pct; // Fallback kalo Kelly dimatiin

    const b = (1 / price) - 1;  // Odds: berapa kali lipat keuntungan kalo menang
    const q = 1 - prob;          // Probabilitas kalah

    // Full Kelly Value (bisa hasilnya negatif, artinya gak boleh beli)
    const kellyValue = (prob * b - q) / b;

    // Fractional Kelly + Batasi maksimum sesuai konfigurasi (default 15%)
    // Kalo hasilnya negatif, langsung return 0
    if (kellyValue <= 0) return 0;
    const finalValue = kellyValue * config.kelly_fraction;
    return Math.min(finalValue, config.max_position_pct);
}

/**
 * Hitung harga Stop Loss (default 20% di bawah harga beli)
 */
export function calculateStopLoss(entryPrice: number, config: BotConfig): number {
    return entryPrice * (1 - config.stop_loss_pct);
}

/**
 * Cek apakah harga saat ini sudah kena Stop Loss?
 */
export function isStopLossHit(entryPrice: number, currentPrice: number, config: BotConfig): boolean {
    const stopPrice = calculateStopLoss(entryPrice, config);
    return currentPrice <= stopPrice;
}

/**
 * Logika Trailing Stop (dari bot Python V2)
 * Kalo harga sudah naik di atas activation threshold (misal 20%), stop loss akan naik mengikuti harga tertinggi.
 */
export function updateTrailingStop(
    entryPrice: number,
    currentPrice: number,
    highestPrice: number,
    config: BotConfig
): number | null {
    // Activation price: misal entry $0.20 * 1.20 = $0.24
    const activateThreshold = entryPrice * (1 + config.trailing_activate_pct);

    // Cek apakah trailing stop sudah aktif
    if (currentPrice >= activateThreshold) {
        // Trailing stop akan berada di 15% di bawah harga tertinggi (highestPrice)
        // Contoh: kalo highestPrice $0.30, stop loss-nya di $0.255
        const trailPct = 0.85;
        const newStop = highestPrice * trailPct;
        // Stop loss tidak boleh lebih rendah dari harga beli (break even)
        return Math.max(newStop, entryPrice);
    }
    return null; // Trail belum aktif
}
