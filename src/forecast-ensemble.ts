// src/forecast-ensemble.ts - VERSI UPGRADE (Step 4)
// Pake ensemble, confidence filter
import { CityData } from "./cities";

export async function getEnsembleTemperatures(city: CityData, targetDate: string): Promise<number[] | null> {
    const tempUnit = city.unit === 'F' ? 'fahrenheit' : 'celsius';
    const url = `https://api.open-meteo.com/v1/ensemble?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&models=gfs_seamless&ensemble_members=31&temperature_unit=${tempUnit}&timezone=auto&start_date=${targetDate}&end_date=${targetDate}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.daily || !data.daily.temperature_2m_max) {
            console.warn(`[Ensemble] No data for ${city.name} on ${targetDate}`);
            return null;
        }
        
        const meanTemp = data.daily.temperature_2m_max[0];
        const sigma = city.unit === 'F' ? 2.5 : 1.5;
        
        // Generate 31 sample dari distribusi normal
        const samples: number[] = [];
        for (let i = 0; i < 31; i++) {
            const u1 = Math.random();
            const u2 = Math.random();
            const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
            const sample = meanTemp + z0 * sigma;
            samples.push(Math.round(sample * 10) / 10);
        }
        return samples;
        
    } catch (error) {
        console.error(`[Ensemble] Failed for ${city.name}:`, error);
        return null;
    }
}

export function calculateProbabilityFromEnsemble(samples: number[], low: number, high: number): number {
    if (!samples || samples.length === 0) return 0;
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
    const prob = count / samples.length;
    return prob;
}

/**
 * CONFIDENCE FILTER: kalo modelProb < 0.62, skip
 */
export function isConfidentEnough(modelProb: number): boolean {
    return modelProb >= 0.62;
}
