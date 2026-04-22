import axios from "axios";
import { ClobClient, AssetType } from "@polymarket/clob-client";
import type { BotConfig } from "./config";
import { getApiCreds, getFunderAddress, getSignerWallet } from "./clob";

const POLYGON_RPC = "https://polygon-rpc.com";
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS = 6;
const BALANCE_OF_SELECTOR = "0x70a08231";

/**
 * Get USDC balance via Polymarket CLOB API. Correct for EOA (0), Polymarket proxy (1), and Gnosis Safe (2).
 * Uses config.use_proxy_wallet and config.signature_type so the right funder/signature type is used.
 * Returns balance in USD, or 0 on error.
 */
export async function getWalletBalanceUsdViaClob(cfg: BotConfig): Promise<number> {
  const pk = (cfg.polymarket_private_key || "").trim();
  if (!pk) return 0;

  try {
    const { wallet, apiCreds } = await getApiCreds(cfg);
    const signatureType = cfg.signature_type;
    const funderAddress = getFunderAddress(cfg, wallet);

    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      apiCreds,
      signatureType,
      funderAddress || undefined
    );

    const res = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL
    });
    const raw = parseFloat(res?.balance ?? "0");
    const balance = raw / 10 ** USDC_DECIMALS;
    return Number.isFinite(balance) ? balance : 0;
  } catch {
    const wallet = getSignerWallet(cfg);
    const funderAddress = getFunderAddress(cfg, wallet);
    if (!funderAddress) return 0;
    return getWalletBalanceUsd(funderAddress);
  }
}

/**
 * Get USDC balance for an address on Polygon via direct eth_call (EOA only).
 * Use getWalletBalanceUsdViaClob when using proxy/safe so CLOB returns the correct balance.
 */
export async function getWalletBalanceUsd(
  walletAddress: string
): Promise<number> {
  const addr = (walletAddress || "").trim();
  if (!addr || !addr.startsWith("0x") || addr.length !== 42) {
    return 0;
  }

  const paddedAddr = addr.slice(2).toLowerCase().padStart(64, "0");
  const data = BALANCE_OF_SELECTOR + paddedAddr;

  try {
    const r = await axios.post(
      POLYGON_RPC,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: USDC_POLYGON,
            data
          },
          "latest"
        ]
      },
      { timeout: 10000 }
    );

    const hex = r.data?.result as string | undefined;
    if (!hex || typeof hex !== "string") return 0;

    const raw = BigInt(hex);
    const balance = Number(raw) / 10 ** USDC_DECIMALS;
    return Number.isFinite(balance) ? balance : 0;
  } catch {
    return 0;
  }
}
