// src/alpha.ts - WEEK 2 (Liquidity Scoring + Spread Filter)
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

// ========== 3. CONFIDENCE SCORE ==========
export function getConfidence(modelProb: number): number {
  if (modelProb >= 0.85) return 1.2;
  if (modelProb >= 0.75) return 1.0;
  if (modelProb >= 0.68) return 0.9;
  if (modelProb >= 0.62) return 0.8;
  if (modelProb >= 0.55) return 0.7;
  return 0.5;
}

// ========== 4. LIQUIDITY SCORING (WEEK 2) ==========
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
    spreadScore = Math.max(0, 100 - ((spreadPercent - 0.02) / 0.06) * 100);
  }
  
  const totalScore = (depthScore * 0.3) + (volumeScore * 0.3) + (spreadScore * 0.4);
  const isLiquid = depthScore >= 30 && volumeScore >= 20 && spreadScore >= 60;
  
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

// ========== 5. RANK CANDIDATES (with liquidity weighting) ==========
export function rankCandidates(candidates: AlphaCandidate[]): AlphaCandidate[] {
  return candidates
    .filter(c => c.edge >= 0.07)
    .filter(c => c.confidence >= 0.7)
    .filter(c => c.liquidityScore >= 40)
    .sort((a, b) => {
      const edgeNormA = Math.min(a.edge / 0.20, 1);
      const edgeNormB = Math.min(b.edge / 0.20, 1);
      const scoreA = (edgeNormA * 0.5) + (a.confidence * 0.25) + ((a.liquidityScore / 100) * 0.25);
      const scoreB = (edgeNormB * 0.5) + (b.confidence * 0.25) + ((b.liquidityScore / 100) * 0.25);
      return scoreB - scoreA;
    })
    .slice(0, 2);
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

// ========== WEEK 3: DISAGREEMENT ALPHA (Chaos Pays) ==========
export function getDisagreementEdgeBoost(
  disagreementScore: number, 
  unit: 'F' | 'C', 
  baseEdge: number
): number {
  const threshold = unit === 'F' ? 4.0 : 2.2;
  if (disagreementScore >= threshold) {
    // High disagreement = market often mispriced
    return baseEdge * 1.3;
  }
  return baseEdge;
}

export function getConsensusPenalty(consensus: boolean): number {
  // Consensus is good, but sometimes overpriced
  return consensus ? 1.0 : 1.05;  // 5% boost for non-consensus
}
