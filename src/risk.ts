// src/risk.ts

/**
 * Menghitung ukuran posisi pake Fractional Kelly Criterion
 * @param prob - Probabilitas menang (0-1) - ini nanti lo dapet dari forecast
 * @param price - Harga YES saat ini (misal 0.25 = 25%)
 * @param kellyFraction - 0.25 (seperempat Kelly, biar aman)
 * @returns Persentase dari balance yang boleh dipertaruhkan (0-1)
 */
export function calculateKellyPosition(prob: number, price: number, kellyFraction: number = 0.25): number {
    if (price <= 0 || price >= 1) return 0;
    
    const b = (1 / price) - 1;  // Odds: kalo menang, dapet berapa kali lipat
    const q = 1 - prob;          // Probabilitas kalah
    
    const kellyValue = (prob * b - q) / b;
    
    // Gak boleh lebih dari 15% dari balance, dan minimal 1%
    return Math.min(Math.max(kellyValue * kellyFraction, 0.01), 0.15);
}

/**
 * Hitung harga Stop Loss (20% dari harga beli)
 * Logika ini persis dari bot Python lo: stop = entry * 0.80
 */
export function calculateStopLoss(entryPrice: number): number {
    return entryPrice * 0.80;
}

/**
 * Cek apakah kena Stop Loss? (Untuk exit otomatis)
 */
export function isStopLossHit(entryPrice: number, currentPrice: number): boolean {
    const stopPrice = calculateStopLoss(entryPrice);
    return currentPrice <= stopPrice;
}

/**
 * Logika Trailing Stop (Bot Python V2 lo punya ini)
 * Kalo harga udah naik 20% dari entry, stop loss akan naik ke harga entry (break even)
 * @param entryPrice - Harga beli awal
 * @param currentPrice - Harga saat ini
 * @param highestPrice - Harga tertinggi yang pernah tercapai sejak beli
 * @returns Harga stop loss yang baru (atau null kalo belum berubah)
 */
export function updateTrailingStop(entryPrice: number, currentPrice: number, highestPrice: number): number | null {
    // Kalo udah profit 20% atau lebih
    if (currentPrice >= entryPrice * 1.20) {
        // Pake trailing 15% dari harga tertinggi
        const newStop = highestPrice * 0.85;
        // Stop baru gak boleh lebih rendah dari harga beli
        return Math.max(newStop, entryPrice);
    }
    return null;
}
