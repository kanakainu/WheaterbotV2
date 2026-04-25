// src/forecast.ts - GLOBAL FORECAST (Open-Meteo)
import { warn } from "./colors";

export interface CityForecast {
  lat: number;
  lon: number;
  name: string;
  unit: 'F' | 'C';
  slug: string;
  station?: string;
}

const GLOBAL_CITIES: Record<string, CityForecast> = {
  nyc:     { slug: "nyc", name: "New York City", lat: 40.7772, lon: -73.8726, unit: "F", station: "KLGA" },
  chicago: { slug: "chicago", name: "Chicago",   lat: 41.9742, lon: -87.9073, unit: "F", station: "KORD" },
  miami:   { slug: "miami", name: "Miami",       lat: 25.7959, lon: -80.2870, unit: "F", station: "KMIA" },
  dallas:  { slug: "dallas", name: "Dallas",     lat: 32.8471, lon: -96.8518, unit: "F", station: "KDAL" },
  seattle: { slug: "seattle", name: "Seattle",   lat: 47.4502, lon: -122.3088, unit: "F", station: "KSEA" },
  atlanta: { slug: "atlanta", name: "Atlanta",   lat: 33.6407, lon: -84.4277, unit: "F", station: "KATL" },
  seoul:   { slug: "seoul", name: "Seoul",       lat: 37.4691, lon: 126.4505, unit: "C", station: "RKSI" },
  tokyo:   { slug: "tokyo", name: "Tokyo",       lat: 35.7647, lon: 140.3864, unit: "C", station: "RJTT" },
  singapore:{ slug: "singapore", name:"Singapore",lat:1.3502,  lon: 103.9940, unit: "C", station: "WSSS" },
  london:  { slug: "london", name: "London",     lat: 51.5048, lon: 0.0495,   unit: "C", station: "EGLC" },
  paris:   { slug: "paris", name: "Paris",       lat: 48.9962, lon: 2.5979,   unit: "C", station: "LFPG" },
  berlin:  { slug: "berlin", name: "Berlin",     lat: 52.5200, lon: 13.4050,  unit: "C", station: "EDDB" },
};

export type DailyForecast = Record<string, number>;

export async function getForecast(citySlug: string): Promise<DailyForecast> {
  const city = GLOBAL_CITIES[citySlug];
  if (!city) {
    warn(`City ${citySlug} not found`);
    return {};
  }

  const tempUnit = city.unit === 'F' ? 'fahrenheit' : 'celsius';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&temperature_unit=${tempUnit}&forecast_days=5&timezone=auto`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.daily?.time) return {};

    const forecast: DailyForecast = {};
    const times = data.daily.time as string[];
    const temps = data.daily.temperature_2m_max as number[];

    for (let i = 0; i < times.length; i++) {
      let temp = temps[i];
      forecast[times[i]] = city.unit === 'F' ? Math.round(temp) : Math.round(temp * 10) / 10;
    }
    return forecast;
  } catch (error) {
    warn(`Forecast error for ${city.name}: ${error}`);
    return {};
  }
}

export function getCityData(citySlug: string): CityForecast | null {
  return GLOBAL_CITIES[citySlug] || null;
}
