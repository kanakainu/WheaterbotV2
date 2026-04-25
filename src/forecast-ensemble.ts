// src/forecast-ensemble.ts - WEEK 3 (Multi-model Ensemble + Disagreement Alpha)
import { CityData } from "./cities";

export interface ModelVote {
  model: string;
  forecast: number;
  probability: number;
  weight: number;
}

// Model weights (ECMWF most accurate globally)
const MODEL_WEIGHTS = {
  ecmwf: 0.50,      // 50% weight - best global model
  noaa: 0.30,       // 30% weight - GFS/NOAA
  openmeteo: 0.20,  // 20% weight
};

/**
 * Fetch forecast from Open-Meteo (already implemented)
 */
async function getOpenMeteoForecast(city: CityData, targetDate: string): Promise<number | null> {
  const tempUnit = city.unit === 'F' ? 'fahrenheit' : 'celsius';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&temperature_unit=${tempUnit}&timezone=auto&start_date=${targetDate}&end_date=${targetDate}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.daily?.temperature_2m_max?.[0]) {
      let temp = data.daily.temperature_2m_max[0];
      return city.unit === 'F' ? Math.round(temp) : Math.round(temp * 10) / 10;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch forecast from ECMWF via Open-Meteo
 */
async function getECMWFForecast(city: CityData, targetDate: string): Promise<number | null> {
  const tempUnit = city.unit === 'F' ? 'fahrenheit' : 'celsius';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&temperature_unit=${tempUnit}&models=ecmwf_ifs025&timezone=auto&start_date=${targetDate}&end_date=${targetDate}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.daily?.temperature_2m_max?.[0]) {
      let temp = data.daily.temperature_2m_max[0];
      return city.unit === 'F' ? Math.round(temp) : Math.round(temp * 10) / 10;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch forecast from NOAA/GFS via Open-Meteo
 */
async function getNOAAForecast(city: CityData, targetDate: string): Promise<number | null> {
  const tempUnit = city.unit === 'F' ? 'fahrenheit' : 'celsius';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&temperature_unit=${tempUnit}&models=gfs_seamless&timezone=auto&start_date=${targetDate}&end_date=${targetDate}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.daily?.temperature_2m_max?.[0]) {
      let temp = data.daily.temperature_2m_max[0];
      return city.unit === 'F' ? Math.round(temp) : Math.round(temp * 10) / 10;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get ensemble temperatures from all models
 */
export async function getMultiModelEnsemble(city: CityData, targetDate: string): Promise<{
  forecasts: ModelVote[];
  weightedForecast: number;
  disagreementScore: number;
  consensus: boolean;
}> {
  const [ecmwf, noaa, openmeteo] = await Promise.all([
    getECMWFForecast(city, targetDate),
    getNOAAForecast(city, targetDate),
    getOpenMeteoForecast(city, targetDate)
  ]);
  
  const forecasts: ModelVote[] = [];
  
  if (ecmwf !== null) {
    forecasts.push({ model: 'ecmwf', forecast: ecmwf, probability: 0, weight: MODEL_WEIGHTS.ecmwf });
  }
  if (noaa !== null) {
    forecasts.push({ model: 'noaa', forecast: noaa, probability: 0, weight: MODEL_WEIGHTS.noaa });
  }
  if (openmeteo !== null) {
    forecasts.push({ model: 'openmeteo', forecast: openmeteo, probability: 0, weight: MODEL_WEIGHTS.openmeteo });
  }
  
  if (forecasts.length === 0) {
    return { forecasts: [], weightedForecast: 0, disagreementScore: 0, consensus: false };
  }
  
  // Calculate weighted forecast
  let totalWeight = 0;
  let weightedSum = 0;
  for (const f of forecasts) {
    weightedSum += f.forecast * f.weight;
    totalWeight += f.weight;
  }
  const weightedForecast = weightedSum / totalWeight;
  
  // Calculate disagreement score (standard deviation)
  const forecastsOnly = forecasts.map(f => f.forecast);
  const mean = forecastsOnly.reduce((a, b) => a + b, 0) / forecastsOnly.length;
  const variance = forecastsOnly.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / forecastsOnly.length;
  const disagreementScore = Math.sqrt(variance);
  
  // Consensus if disagreement < 1.5°F (or 0.8°C)
  const consensusThreshold = city.unit === 'F' ? 1.5 : 0.8;
  const consensus = disagreementScore <= consensusThreshold;
  
  return { forecasts, weightedForecast, disagreementScore, consensus };
}

/**
 * Get ensemble temperatures (legacy, for compatibility)
 */
export async function getEnsembleTemperatures(city: CityData, targetDate: string): Promise<number[] | null> {
  const result = await getMultiModelEnsemble(city, targetDate);
  if (result.forecasts.length === 0) return null;
  
  // Generate samples from models
  const samples: number[] = [];
  for (const f of result.forecasts) {
    for (let i = 0; i < 10; i++) {
      samples.push(f.forecast + (Math.random() - 0.5) * 2);
    }
  }
  return samples;
}

export function calculateProbabilityFromEnsemble(samples: number[], low: number, high: number): number {
  if (!samples || samples.length === 0) return 0.5;
  let count = 0;
  for (const temp of samples) {
    if (low === -999) {
      if (temp <= high) count++;
    } else if (high === 999) {
      if (temp >= low) count++;
    } else {
      if (temp >= low && temp <= high) count++;
    }
  }
  return count / samples.length;
}

export function isConfidentEnough(modelProb: number): boolean {
  return modelProb >= 0.62;
}

// ========== WEEK 3: DISAGREEMENT ALPHA ==========
export function getDisagreementMultiplier(disagreementScore: number, unit: 'F' | 'C'): number {
  const threshold = unit === 'F' ? 4.0 : 2.2;  // 4°F disagreement
  if (disagreementScore >= threshold) {
    return 1.3;  // 30% boost for high disagreement (chaos pays)
  }
  return 1.0;
}

export function shouldBoostOnDisagreement(disagreementScore: number, unit: 'F' | 'C'): boolean {
  const threshold = unit === 'F' ? 4.0 : 2.2;
  return disagreementScore >= threshold;
}
