// src/nws.ts - Minimal, cuma buat export LOCATIONS (nama kota)
export const LOCATIONS: Record<string, { name: string }> = {
  nyc:     { name: "New York City" },
  chicago: { name: "Chicago" },
  miami:   { name: "Miami" },
  dallas:  { name: "Dallas" },
  seattle: { name: "Seattle" },
  atlanta: { name: "Atlanta" },
  london:  { name: "London" },
  tokyo:   { name: "Tokyo" },
  seoul:   { name: "Seoul" },
  singapore:{ name: "Singapore" },
  paris:   { name: "Paris" },
  berlin:  { name: "Berlin" },
};

export async function getForecast(citySlug: string): Promise<Record<string, number>> {
  return {};
}
