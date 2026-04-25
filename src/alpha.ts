// src/alpha.ts - Alpha ranking system (Step 6)
// Ranking berdasarkan (edge*confidence)/spread

export interface AlphaCandidate {
    marketId: string;
    tokenId?: string;
    price: number;
    modelProb: number;
    edge: number;
    spread: number;
    volume24h: number;
    question: string;
    citySlug: string;
    forecastTemp: number;
    matchedMarket: any;
}

/**
 * Hitung alpha score = (edge * confidence) / spread
 * Semakin tinggi, semakin bagus
 */
export function calculateAlphaScore(edge: number, confidence: number, spread: number): number {
    if (spread <= 0 || spread > 0.1) return 0;
    return (edge * confidence) / spread;
}

/**
 * Ranking candidates berdasarkan alpha score
 * Ambil top 2 trades per run
 */
export function rankCandidates(candidates: AlphaCandidate[]): AlphaCandidate[] {
    return candidates
        .filter(c => c.edge >= 0.08)  // minimal edge 8%
        .filter(c => c.volume24h >= 10000)  // minimal volume $10k
        .sort((a, b) => {
            const scoreA = calculateAlphaScore(a.edge, a.modelProb, a.spread);
            const scoreB = calculateAlphaScore(b.edge, b.modelProb, b.spread);
            return scoreB - scoreA;
        })
        .slice(0, 2);  // Ambil top 2, gak lebih
}

/**
 * Get confidence level dari model probability
 */
export function getConfidence(modelProb: number): number {
    if (modelProb >= 0.8) return 1.2;
    if (modelProb >= 0.7) return 1.0;
    if (modelProb >= 0.62) return 0.8;
    return 0;
}
