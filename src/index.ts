#!/usr/bin/env node
import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { BotConfig, loadConfig, getActiveLocations } from "./config";
import { badge, panel, stat } from "./colors";
import { resetSim } from "./simState";
import { run, showPositions, type TradeMode } from "./strategy";
import { getWalletBalanceUsdViaClob } from "./walletBalance";
import * as db from "./db";
import { runArbitrageScanner } from "./arbitrage";

dotenv.config();

function validateKeys(cfg: BotConfig): void {
  const errors: string[] = [];
  let pk = (cfg.polymarket_private_key || "").trim();
  const addr = (cfg.polymarket_proxy_wallet_address || "").trim();

  // FIX: Add --paper flag support
  const mode = process.argv.includes("--execute") ? "execute" : 
               process.argv.includes("--live") ? "paper" : 
               process.argv.includes("--paper") ? "paper" : "dry-run";
  
  if (mode === "execute") {
    if (!pk) {
      errors.push("POLYMARKET_PRIVATE_KEY is missing in .env (required for --execute mode)");
    } else {
      const bare = pk.startsWith("0x") ? pk.slice(2) : pk;
      if (!/^[a-fA-F0-9]{64}$/.test(bare)) {
        errors.push(
          "POLYMARKET_PRIVATE_KEY must be 64 hex characters (with or without 0x prefix)"
        );
      } else {
        pk = "0x" + bare;
        cfg.polymarket_private_key = pk;
        process.env.POLYMARKET_PRIVATE_KEY = pk;
      }
    }

    if (!addr) {
      errors.push("POLYMARKET_PROXY_WALLET_ADDRESS is missing in .env (required for --execute mode)");
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      errors.push(
        "POLYMARKET_PROXY_WALLET_ADDRESS must be a 0x-prefixed 40-hex address"
      );
    }
  }

  if (errors.length) {
    console.error(
      "\n" +
        panel(
          "Configuration Error",
          errors.map((error, idx) => `${idx + 1}. ${error}`),
          "red"
        )
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("weatherbot-ts")
    .option("execute", {
      type: "boolean",
      default: false,
      describe: "Place real limit orders on Polymarket CLOB (requires USDC + allowance)"
    })
    .option("live", {
      type: "boolean",
      default: false,
      describe: "Paper trading: update simulation with virtual PnL (no on-chain orders)"
    })
    .option("paper", {
      type: "boolean",
      default: false,
      describe: "Paper trading mode (alias for --live)"
    })
    .option("interval", {
      type: "number",
      default: 0,
      describe: "With --execute or --live: run every N minutes (e.g. 30). Ctrl+C to stop."
    })
    .option("positions", {
      type: "boolean",
      default: false,
      describe: "Show open positions"
    })
    .option("reset", {
      type: "boolean",
      default: false,
      describe: "Reset paper simulation to $200 virtual balance"
    })
    .option("db-reset", {
      type: "boolean",
      default: false,
      describe: "Reset SQLite database (clear all positions and trades)"
    })
    .option("arb", {
      type: "boolean",
      default: false,
      describe: "Run arbitrage scanner (YES + NO < 1)"
    })
    .option("balance", {
      type: "number",
      default: 200,
      describe: "Set initial virtual balance for paper trading (default: 200)"
    })
    .help()
    .parseAsync();

  const cfg = await loadConfig();
  
  if (argv["db-reset"]) {
    console.log("\n" + panel("Database Reset", [
      "Resetting SQLite database...",
      "All positions and trades will be cleared."
    ], "yellow"));
    db.resetAll();
    console.log(panel("Database Reset Complete", [
      "Database has been reset to clean state.",
      "Run with --live to start fresh paper trading."
    ], "green"));
    return;
  }

  if (argv.reset) {
    console.log("\n" + panel("Reset Simulation", [
      "Resetting paper simulation to virtual balance..."
    ], "yellow"));
    db.resetAll();
    await resetSim();
    return;
  }

  if (argv.positions) {
    await showPositions();
    return;
  }

  if (argv.arb) {
    const locations = getActiveLocations(cfg);
    await runArbitrageScanner(locations);
    return;
  }

  // FIX: Support --paper flag
  const execute = Boolean(argv.execute);
  const paper = Boolean(argv.live) || Boolean(argv.paper);

  if (execute && paper) {
    console.error(
      "Choose one: --execute (real CLOB trades) or --live/--paper (paper simulation), not both."
    );
    process.exit(1);
  }

  const mode: TradeMode = execute ? "execute" : paper ? "paper" : "dry-run";

  if (mode === "execute") {
    validateKeys(cfg);
  }

  let walletUsd: number | undefined;
  if (mode === "execute") {
    walletUsd = await getWalletBalanceUsdViaClob(cfg);
    if (walletUsd <= 0) {
      console.error(
        "\n" +
          panel(
            "Insufficient Balance",
            [
              "Wallet balance is $0 or could not be fetched.",
              "Make sure you have USDC on Polygon network.",
              `Balance returned: $${walletUsd?.toFixed(2) ?? 'unknown'}`
            ],
            "red"
          )
      );
    } else {
      console.info(
        "\n" +
          panel(
            "Live Wallet Check",
            [
              `${badge("EXECUTE", "green")} Real Polymarket CLOB trading is enabled`,
              stat("Wallet balance", `$${walletUsd.toFixed(2)} USD`, "cyan")
            ],
            "green"
          )
      );
    }
  } else {
    const balance = db.getBalance();
    console.info(
      "\n" +
        panel(
          mode === "paper" ? "Paper Trading Mode" : "Dry Run Mode",
          [
            stat("Virtual balance", `$${balance.toFixed(2)} USD`, "cyan"),
            mode === "dry-run" ? stat("Orders", "Not placed (dry-run)", "yellow") : stat("Orders", "Simulated (paper)", "green")
          ],
          mode === "paper" ? "green" : "yellow"
        )
    );
  }

  const intervalMin =
    (execute || paper) &&
    typeof argv.interval === "number" &&
    argv.interval > 0
      ? argv.interval
      : 0;

  if (intervalMin > 0) {
    const intervalSec = intervalMin * 60;
    console.info(
      "\n" +
        panel(
          "Loop Mode Active",
          [
            stat("Run cadence", `Every ${intervalMin.toFixed(1)} min`, "blue"),
            stat("Stop", "Ctrl+C", "yellow")
          ],
          "blue"
        ) +
        "\n"
    );
    while (true) {
      if (mode === "execute") {
        walletUsd = await getWalletBalanceUsdViaClob(cfg);
        if (walletUsd <= 0) {
          console.warn("⚠️  Warning: Zero balance for live trading. Skipping cycle.");
          await new Promise((res) => setTimeout(res, intervalSec * 1000));
          continue;
        }
      }
      await run({ mode, config: cfg, walletUsd });
      console.info(
        "\n" +
          panel(
            "Cooldown",
            [stat("Next run", `In ${intervalMin.toFixed(1)} min`, "cyan")],
            "cyan"
          ) +
          "\n"
      );
      await new Promise((res) => setTimeout(res, intervalSec * 1000));
    }
  } else {
    await run({ mode, config: cfg, walletUsd });
  }
}

main().catch((err) => {
  console.error(
    "\n" +
      panel(
        "Fatal Error",
        [String(err instanceof Error ? err.stack ?? err.message : err)],
        "red"
      )
  );
  process.exit(1);
});
