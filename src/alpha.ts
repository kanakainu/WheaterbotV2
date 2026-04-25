// src/alpha.ts - ALPHA ENGINE (Edge Filter, Ranking, Correlation)

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
  region: string;
  forecastTemp: number;
  confidence: number;
}

// ========== 1. EDGE CALCULATION ==========
export function calculateEdge(prob: number, marketPrice: number): number {
  return prob - marketPrice;
}

// ========== 2. EDGE TIERS ==========
export function getEdgeTier(edge: number): 'weak' | 'normal' | 'strong' | 'hammer' {
  if (edge >= 0.15) return 'hammer';
  if (edge >= 0.10) return 'strong';
  if (edge >= 0.07) return 'normal';
  return 'weak';
}

export function getEdgeMultiplier(edge: number): number {
  if (edge >= 0.15) return 1.5;
  if (edge >= 0.10) return 1.2;
  if (edge >= 0.07) return 1.0;
  return 0.5;
}

// ========== 3. CONFIDENCE SCORE (dari model) ==========
export function getConfidence(modelProb: number): number {
  if (modelProb >= 0.85) return 1.2;
  if (modelProb >= 0.75) return 1.0;
  if (modelProb >= 0.68) return 0.9;
  if (modelProb >= 0.62) return 0.8;
  if (modelProb >= 0.55) return 0.7;
  return 0.5;
}

// ========== 4. LIQUIDITY SCORE ==========
export function calculateLiquidityScore(
  depth: number,
  spread: number,
  volume24h: number
): number {
  // Depth score (0-100)
  let depthScore = Math.min(depth / 5000, 1) * 100;
  
  // Volume score (0-100)
  let volumeScore = Math.min(volume24h / 50000, 1) * 100;
  
  // Spread penalty (0-100)
  let spreadPenalty = Math.max(0, 100 - (spread / 0.02) * 100);
  
  // Weighted score
  const score = (depthScore * 0.4) + (volumeScore * 0.4) + (spreadPenalty * 0.2);
  
  return Math.min(100, Math.max(0, score));
}

// ========== 5. RANK CANDIDATES ==========
export function rankCandidates(candidates: AlphaCandidate[]): AlphaCandidate[] {
  return candidates
    .filter(c => c.edge >= 0.07)                    // Minimal edge 7%
    .filter(c => c.confidence >= 0.7)               // Minimal confidence 70%
    .sort((a, b) => {
      // Weighted score: edge (60%) + confidence (30%) + liquidity (10%)
      const scoreA = (a.edge * 0.6) + (a.confidence * 0.3) + (Math.min(a.volume24h / 50000, 1) * 0.1);
      const scoreB = (b.edge * 0.6) + (b.confidence * 0.3) + (Math.min(b.volume24h / 50000, 1) * 0.1);
      return scoreB - scoreA;
    })
    .slice(0, 2);                                   // Max 2 trades per run
}

// ========== 6. REGION MAPPING (untuk correlation filter) ==========
const REGION_MAP: Record<string, string> = {
  nyc: 'northeast',
  chicago: 'midwest',
  miami: 'southeast',
  dallas: 'southcentral',
  seattle: 'northwest',
  atlanta: 'southeast',
  london: 'europe',
  paris: 'europe',
  berlin: 'europe',
  tokyo: 'asia',
  seoul: 'asia',
  singapore: 'asia',
};

export function getRegion(citySlug: string): string {
  return REGION_MAP[citySlug] || 'unknown';
}

export function isCorrelated(region1: string, region2: string): boolean {
  return region1 === region2 && region1 !== 'unknown';
}
