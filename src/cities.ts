// src/cities.ts
// 🌍 DAFTAR 30+ KOTA GLOBAL DARI BOT LAMA LO (Python V2)

export interface CityData {
    slug: string;
    name: string;
    lat: number;
    lon: number;
    station: string;    // Kode bandara untuk resolve market
    unit: 'F' | 'C';
    region: 'us' | 'eu' | 'asia' | 'oc';
}

export const CITIES: Record<string, CityData> = {
    // 🇺🇸 UNITED STATES
    nyc:     { slug: "nyc", name: "New York",     lat: 40.7772, lon: -73.8726, station: "KLGA", unit: "F", region: "us" },
    chicago: { slug: "chicago", name: "Chicago",  lat: 41.9742, lon: -87.9073, station: "KORD", unit: "F", region: "us" },
    miami:   { slug: "miami", name: "Miami",      lat: 25.7959, lon: -80.2870, station: "KMIA", unit: "F", region: "us" },
    dallas:  { slug: "dallas", name: "Dallas",    lat: 32.8471, lon: -96.8518, station: "KDAL", unit: "F", region: "us" },
    seattle: { slug: "seattle", name: "Seattle",  lat: 47.4502, lon: -122.3088, station: "KSEA", unit: "F", region: "us" },
    atlanta: { slug: "atlanta", name: "Atlanta",  lat: 33.6407, lon: -84.4277, station: "KATL", unit: "F", region: "us" },

    // 🇬🇧🇪🇺 EUROPE (UNITED KINGDOM, FRANCE, GERMANY, etc)
    london:  { slug: "london", name: "London",    lat: 51.5048, lon: 0.0495,   station: "EGLC", unit: "C", region: "eu" },
    paris:   { slug: "paris", name: "Paris",      lat: 48.9962, lon: 2.5979,   station: "LFPG", unit: "C", region: "eu" },
    munich:  { slug: "munich", name: "Munich",    lat: 48.3537, lon: 11.7750,  station: "EDDM", unit: "C", region: "eu" },
    berlin:  { slug: "berlin", name: "Berlin",    lat: 52.5200, lon: 13.4050,  station: "EDDB", unit: "C", region: "eu" },
    zurich:  { slug: "zurich", name: "Zurich",    lat: 47.3769, lon: 8.5417,   station: "LSZH", unit: "C", region: "eu" },
    madrid:  { slug: "madrid", name: "Madrid",    lat: 40.4168, lon: -3.7038,  station: "LEMD", unit: "C", region: "eu" },
    milan:   { slug: "milan", name: "Milan",      lat: 45.4642, lon: 9.1900,   station: "LIMC", unit: "C", region: "eu" },
    istanbul:{ slug: "istanbul", name:"Istanbul", lat: 41.0082, lon: 28.9784,  station: "LTFM", unit: "C", region: "eu" },
    
    // 🌏 ASIA PACIFIC
    seoul:   { slug: "seoul", name: "Seoul",      lat: 37.4691, lon: 126.4505, station: "RKSI", unit: "C", region: "asia" },
    tokyo:   { slug: "tokyo", name: "Tokyo",      lat: 35.7647, lon: 140.3864, station: "RJTT", unit: "C", region: "asia" },
    shanghai:{ slug: "shanghai", name:"Shanghai", lat: 31.1443, lon: 121.8083, station: "ZSPD", unit: "C", region: "asia" },
    singapore:{slug:"singapore", name:"Singapore",lat:1.3502,  lon: 103.9940, station: "WSSS", unit: "C", region: "asia" },
    hongkong:{ slug: "hongkong", name:"Hong Kong",lat:22.3193, lon: 114.1694, station: "VHHH", unit: "C", region: "asia" },
    bangkok: { slug: "bangkok", name:"Bangkok",   lat:13.7367, lon: 100.5231, station: "VTBS", unit: "C", region: "asia" },
    
    // 🇦🇺 OCEANIA
    sydney:  { slug: "sydney", name: "Sydney",    lat: -33.8688, lon: 151.2093, station: "YSSY", unit: "C", region: "oc" },
    melbourne:{slug:"melbourne",name:"Melbourne", lat:-37.8136, lon: 144.9631, station: "YMML", unit: "C", region: "oc" },
    wellington:{slug:"wellington",name:"Wellington", lat:-41.3272, lon: 174.8052, station: "NZWN", unit: "C", region: "oc" },
    
    // ... (lo bisa tambahin sendiri dari bot V2 lo yang python)
};

export function getActiveCities(slugs: string[]): CityData[] {
    return slugs.map(slug => CITIES[slug]).filter(city => city !== undefined);
}
