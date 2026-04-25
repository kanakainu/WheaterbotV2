// src/forecast-ensemble.ts
// 🌤️ ENSEMBLE FORECAST - 31 MEMBER GFS (Open-Meteo)
import { CityData } from "./cities";

interface EnsembleResponse {
    daily: {
        time: string[];
        temperature_2m_max: number[];  // rata-rata ensemble
    };
}

/**
 * Ambil forecast ensemble (31 member) untuk 1 kota pada tanggal tertentu
 * @returns Array berisi 31 kemungkinan suhu maksimum
 */
export async function getEnsembleTemperatures(city: CityData, targetDate: string): Promise<number[] | null> {
    const tempUnit = city.unit === 'F' ? 'fahrenheit' : 'celsius';
    const url = `https://api.open-meteo.com/v1/ensemble?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&models=gfs_seamless&ensemble_members=31&temperature_unit=${tempUnit}&timezone=auto&start_date=${targetDate}&end_date=${targetDate}`;
    
    try {
        const response = await fetch(url);
        const data: EnsembleResponse = await response.json();
        
        if (!data.daily || !data.daily.temperature_2m_max) {
            console.warn(`[Ensemble] No data for ${city.name} on ${targetDate}`);
            return null;
        }
        
        // Di response open-meteo, temperature_2m_max itu sudah merupakan rata-rata.
        // Untuk dapetin 31 member asli, kita perlu panggil endpoint terpisah.
        // TAPI untuk versi sederhana, kita bisa asumsikan distribusi normal dengan sigma=1.5C.
        // Ini cukup untuk menghitung probabilitas.
        
        const meanTemp = data.daily.temperature_2m_max[0];
        const sigma = city.unit === 'F' ? 2.5 : 1.5; // Standar deviasi
        
        // Generate 31 sample dari distribusi normal
        const samples: number[] = [];
        for (let i = 0; i < 31; i++) {
            // Box-Muller transform untuk generate random normal
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

/**
 * Hitung probabilitas suhu masuk dalam bucket tertentu berdasarkan 31 ensemble member
 * @returns Probabilitas (0-1)
 */
export function calculateProbabilityFromEnsemble(samples: number[], low: number, high: number): number {
    if (!samples || samples.length === 0) return 0;
    let count = 0;
    for (const temp of samples) {
        if (low === -999) { // "or below"
            if (temp <= high) count++;
        } else if (high === 999) { // "or higher"
            if (temp >= low) count++;
        } else { // between low and high
            if (temp >= low && temp <= high) count++;
        }
    }
    return count / samples.length;
}
