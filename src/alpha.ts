// src/alpha.ts - FIXED VERSION (rankCandidates tidak refilter edge/confidence)

export interface AlphaCandidate {
  marketId: string;
  tokenId?: string;
  price: number;
  modelProb: number;
  edge: number;
  spread: number;
  spreadPercent: number;
  spreadScore: number;
  volume24h: number;
  depthUSDC: number;
  liquidityScore: number;
  liquidityTier: string;
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

// ========== 3. CONFIDENCE SCORE (CAP AT 1.0) ==========
export function getConfidence(modelProb: number): number {
  // Cap at 1.0 to avoid overweight
  if (modelProb >= 0.85) return 1.0;
  if (modelProb >= 0.75) return 0.95;
  if (modelProb >= 0.68) return 0.85;
  if (modelProb >= 0.62) return 0.75;
  if (modelProb >= 0.55) return 0.65;
  return 0.50;
}

// ========== 4. LIQUIDITY SCORING ==========
export interface LiquidityMetrics {
  depthScore: number;
  volumeScore: number;
  spreadScore: number;
  totalScore: number;
  isLiquid: boolean;
}

export function calculateLiquidityScore(
  depthUSDC: number,
  volume24h: number,
  spreadPercent: number
): LiquidityMetrics {
  const depthScore = Math.min(depthUSDC / 10000, 1) * 100;
  const volumeScore = Math.min(volume24h / 50000, 1) * 100;
  
  let spreadScore = 100;
  if (spreadPercent > 0.02) {
    spreadScore = Math.max(0, 100 - ((spreadPercent - 0.02) / 0.08) * 100);
  }
  
  const totalScore = (depthScore * 0.3) + (volumeScore * 0.3) + (spreadScore * 0.4);
  
  // Loosened for paper hunting mode
  const isLiquid = depthScore >= 15 && spreadScore >= 35;
  
  return {
    depthScore: Math.round(depthScore),
    volumeScore: Math.round(volumeScore),
    spreadScore: Math.round(spreadScore),
    totalScore: Math.round(totalScore),
    isLiquid
  };
}

export function getLiquidityTier(totalScore: number): 'Excellent' | 'Good' | 'Fair' | 'Poor' {
  if (totalScore >= 80) return 'Excellent';
  if (totalScore >= 60) return 'Good';
  if (totalScore >= 40) return 'Fair';
  return 'Poor';
}

// ========== 5. RANK CANDIDATES (FIXED - NO DOUBLE FILTER) ==========
export function rankCandidates(candidates: AlphaCandidate[]): AlphaCandidate[] {
  if (!candidates.length) return [];
  
  return candidates
    // ONLY filter by liquidity score (edge & confidence already filtered upstream)
    .filter(c => c.liquidityScore >= 30)
    .sort((a, b) => {
      const edgeWeight = 0.50;
      const confWeight = 0.30;
      const liqWeight = 0.20;
      
      const edgeNormA = Math.min(a.edge / 0.15, 1);
      const edgeNormB = Math.min(b.edge / 0.15, 1);
      
      const confA = Math.min(a.confidence, 1);
      const confB = Math.min(b.confidence, 1);
      
      const scoreA = (edgeNormA * edgeWeight) + (confA * confWeight) + ((a.liquidityScore / 100) * liqWeight);
      const scoreB = (edgeNormB * edgeWeight) + (confB * confWeight) + ((b.liquidityScore / 100) * liqWeight);
      
      return scoreB - scoreA;
    })
    .slice(0, 3);
}

// ========== 6. REGION MAPPING ==========
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
