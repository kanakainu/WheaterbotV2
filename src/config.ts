// src/config.ts
import dotenv from 'dotenv';
dotenv.config();

/** Wallet signature type: 0 = EOA, 1 = Polymarket proxy (Magic), 2 = Gnosis Safe */
export type SignatureType = 0 | 1 | 2;

export interface BotConfig {
  // Config Lama
  entry_threshold: number;
  exit_threshold: number;
  max_trades_per_run: number;
  min_hours_to_resolution: number;
  locations: string;
  polymarket_private_key: string;
  polymarket_proxy_wallet_address: string;
  use_proxy_wallet: boolean;
  signature_type: SignatureType;

  // ========== 🚀 KONFIGURASI UPGRADE (DARI BOT LAMA) ==========
  /** Kelly fraction (0-1). Default 0.25 = 25% dari full Kelly */
  kelly_fraction: number;
  /** Stop loss percentage (0-1). Default 0.20 = Stop loss 20% dari entry */
  stop_loss_pct: number;
  /** Trailing stop activation threshold (0-1). Default 0.20 = Aktif setelah profit 20% */
  trailing_activate_pct: number;
  /** Maximum position size as % of balance (0-1). Default 0.15 = 15% max */
  max_position_pct: number;
  /** Minimum Expected Value to enter (in decimals). Default 0.05 = 5% */
  min_ev: number;
  /** Use Kelly for position sizing? Default true */
  use_kelly: boolean;
}

export const DEFAULT_CONFIG: BotConfig = {
  // Config Lama
  entry_threshold: 0.15,
  exit_threshold: 0.45,
  max_trades_per_run: 5,
  min_hours_to_resolution: 2,
  locations: "nyc,chicago,miami,dallas,seattle,atlanta",
  polymarket_private_key: "",
  polymarket_proxy_wallet_address: "",
  use_proxy_wallet: false,
  signature_type: 0,

  // Config Upgrade
  kelly_fraction: 0.25,
  stop_loss_pct: 0.20,
  trailing_activate_pct: 0.20,
  max_position_pct: 0.15,
  min_ev: 0.05,
  use_kelly: true,
};

export async function loadConfig(): Promise<BotConfig> {
  const parseNumber = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const parseBool = (value: string | undefined, fallback: boolean): boolean => {
    if (!value) return fallback;
    return value.toLowerCase() === "true";
  };

  return {
    // Config Lama
    entry_threshold: parseNumber(process.env.ENTRY_THRESHOLD, DEFAULT_CONFIG.entry_threshold),
    exit_threshold: parseNumber(process.env.EXIT_THRESHOLD, DEFAULT_CONFIG.exit_threshold),
    max_trades_per_run: parseNumber(process.env.MAX_TRADES_PER_RUN, DEFAULT_CONFIG.max_trades_per_run),
    min_hours_to_resolution: parseNumber(process.env.MIN_HOURS_TO_RESOLUTION, DEFAULT_CONFIG.min_hours_to_resolution),
    locations: process.env.LOCATIONS ?? DEFAULT_CONFIG.locations,
    polymarket_private_key: process.env.POLYMARKET_PRIVATE_KEY ?? "",
    polymarket_proxy_wallet_address: process.env.POLYMARKET_PROXY_WALLET_ADDRESS ?? "",
    use_proxy_wallet: parseBool(process.env.USE_PROXY_WALLET, DEFAULT_CONFIG.use_proxy_wallet),
    signature_type: (() => {
      const raw = process.env.SIGNATURE_TYPE ?? "";
      if (raw === "1") return 1;
      if (raw === "2") return 2;
      return DEFAULT_CONFIG.use_proxy_wallet ? 2 : 0;
    })(),

    // Config Upgrade
    kelly_fraction: parseNumber(process.env.KELLY_FRACTION, DEFAULT_CONFIG.kelly_fraction),
    stop_loss_pct: parseNumber(process.env.STOP_LOSS_PCT, DEFAULT_CONFIG.stop_loss_pct),
    trailing_activate_pct: parseNumber(process.env.TRAILING_ACTIVATE_PCT, DEFAULT_CONFIG.trailing_activate_pct),
    max_position_pct: parseNumber(process.env.MAX_POSITION_PCT, DEFAULT_CONFIG.max_position_pct),
    min_ev: parseNumber(process.env.MIN_EV, DEFAULT_CONFIG.min_ev),
    use_kelly: parseBool(process.env.USE_KELLY, DEFAULT_CONFIG.use_kelly),
  };
}

export function getActiveLocations(cfg: BotConfig): string[] {
  return cfg.locations.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
