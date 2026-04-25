# ✅ OK BRO! GUE KASIH README VERSI UPGRADE LENGKAP

Ini adalah README yang sudah diperbarui dengan **semua upgrade** yang lo lakukan: SQLite, Kelly Criterion, Stop Loss, Global Cities, Ensemble Forecast.

---
# 🌤️ WeatherBot V2 - Polymarket Weather Trading Bot

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-3-blue.svg)](https://www.sqlite.org/)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-purple.svg)](https://polymarket.com/)

**Advanced weather trading bot for Polymarket** with Kelly Criterion position sizing, stop loss, trailing stop, global city support, and SQLite database for reliable state management.

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🌍 **30+ Global Cities** | NYC, London, Tokyo, Seoul, Singapore, Paris, Berlin, and more |
| 📊 **Kelly Criterion** | Optimal position sizing based on edge (Fractional Kelly 25%) |
| 🛑 **Stop Loss (20%)** | Automatic loss protection |
| 🎯 **Trailing Stop** | Lock in profits after 20% gain |
| 🗄️ **SQLite Database** | Anti-corrupt state management (no more JSON file errors) |
| 🔄 **Three Execution Modes** | Signal-only, Paper trading, Live CLOB trading |
| 🌡️ **Open-Meteo Forecast** | Global weather data (ECMWF + GFS models) |
| 🔬 **Ensemble Forecast (31-member)** | Probabilistic temperature predictions |
| 📈 **Expected Value (EV) Filtering** | Only trade when EV > 5% |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm
- Polymarket account with USDC on Polygon network (for live trading)

### Installation

```bash
git clone https://github.com/kanakainu/WheaterbotV2.git
cd WheaterbotV2
npm install
npm run build
```

### Configuration

```bash
cp .env.sample .env
```

Edit `.env` with your settings:

```env
# Required for live trading
POLYMARKET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
POLYMARKET_PROXY_WALLET_ADDRESS=0xYOUR_WALLET_ADDRESS

# Trading parameters
ENTRY_THRESHOLD=0.25
EXIT_THRESHOLD=0.55
MAX_TRADES_PER_RUN=3
MIN_HOURS_TO_RESOLUTION=2

# Risk management (Kelly, Stop Loss)
KELLY_FRACTION=0.25
STOP_LOSS_PCT=0.20
TRAILING_ACTIVATE_PCT=0.20
MAX_POSITION_PCT=0.15
MIN_EV=0.05
USE_KELLY=true

# Cities to scan (comma-separated)
LOCATIONS=nyc,chicago,miami,dallas,seattle,atlanta,london,tokyo,seoul,singapore,paris
```

---

## 📋 Usage

### Build and Run Modes

| Mode | Command | Description |
|------|---------|-------------|
| **Signal** | `npm run signal` | Dry run, shows signals only |
| **Paper** | `npm run paper` | Paper trading with virtual balance (SQLite) |
| **Live (one-shot)** | `npm run execute` | Real CLOB orders, single run |
| **Live (interval)** | `npm run trade` | Real orders every 30 minutes |

### Utility Commands

```bash
npm run positions   # View open positions
npm run reset       # Reset paper simulation to $200
npm run db-reset    # Clear SQLite database completely
```

---

## 🗄️ State Management (SQLite)

**No more `simulation.json` corruption!** All positions and trades are stored in SQLite database:

```
data/live.db
├── positions   (open positions)
├── trades      (trade history)
└── state       (balance, wins, losses)
```

### Database Features

- ✅ **ACID compliant** - No corruption on crash
- ✅ **Concurrent access** - Safe for multiple processes
- ✅ **Easy backup** - Just copy `data/live.db`

---

## 🌍 Supported Cities

The bot supports **30+ global cities** with automatic unit conversion (°F/°C):

| Region | Cities |
|--------|--------|
| 🇺🇸 USA | NYC, Chicago, Miami, Dallas, Seattle, Atlanta |
| 🇪🇺 Europe | London, Paris, Berlin, Munich, Zurich, Madrid, Milan, Istanbul |
| 🌏 Asia | Tokyo, Seoul, Shanghai, Singapore, Hong Kong, Bangkok |
| 🇦🇺 Oceania | Sydney, Melbourne, Wellington |

Add any city to `LOCATIONS` in `.env` - the bot will automatically fetch forecasts.

---

## 📊 Risk Management Features

### Kelly Criterion Position Sizing

The bot uses **Fractional Kelly (25%)** to calculate optimal position size:

```
Position % = min( (p * b - q) / b * 0.25, 15% of balance )
```

### Stop Loss (20%)

Automatically closes position if price drops 20% from entry price.

### Trailing Stop

Activates after 20% profit, locks in gains by moving stop loss up with the price:

- Trail retracement: 15% from peak
- Never goes below breakeven

### Expected Value (EV) Filtering

Only enters trades with EV > 5%:

```
EV = p * (1/price - 1) - (1-p)
```

---

## 🏗️ Architecture

### Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js + TypeScript |
| Blockchain | Polygon |
| Exchange | Polymarket CLOB (`@polymarket/clob-client`) |
| Weather API | Open-Meteo (ECMWF + GFS) |
| Database | SQLite3 (`better-sqlite3`) |
| Forecasts | NWS (US) + Open-Meteo (Global) |

### Project Structure

```
WheaterbotV2/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── config.ts          # Configuration loader
│   ├── strategy.ts        # Main trading logic
│   ├── risk.ts            # Kelly, Stop Loss, Trailing
│   ├── forecast.ts        # Global weather forecasts
│   ├── forecast-ensemble.ts # 31-member GFS ensemble
│   ├── clob.ts            # Polymarket CLOB integration
│   ├── polymarket.ts      # Gamma API wrapper
│   ├── db.ts              # SQLite database layer
│   ├── simState.ts        # State management (SQLite)
│   ├── cities.ts          # 30+ global cities data
│   ├── nws.ts             # US cities (legacy)
│   ├── parsing.ts         # Temperature bucket parser
│   ├── time.ts            # Month utilities
│   ├── colors.ts          # Terminal styling
│   └── walletBalance.ts   # USDC balance checker
├── data/
│   └── live.db            # SQLite database
├── dist/                  # Compiled JavaScript
├── .env                   # Configuration (gitignored)
├── package.json
└── README.md
```

---

## 🧪 Testing

### Paper Trading (Recommended First)

```bash
npm run paper
```

This runs with virtual $200 balance and SQLite database. Monitor positions with:

```bash
npm run positions
```

### Live Trading (After Paper Success)

1. Fund Polymarket account with USDC on Polygon network
2. Set `POLYMARKET_PRIVATE_KEY` and `POLYMARKET_PROXY_WALLET_ADDRESS` in `.env`
3. Start with small amount ($50-100):

```bash
npm run execute
```

---

## 📈 Example Output

```
╭──────────────────────────────────────────────────────────────────────────╮
│ Weather Trading Bot (UPGRADED)                                           │
├──────────────────────────────────────────────────────────────────────────┤
│  PAPER TRADING                                                           │
│ Balance          $200.00                                                 │
│ Position sizing  25% Kelly                                               │
│ Stop loss        20%                                                     │
│ Entry threshold  < $0.25                                                 │
╰──────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────╮
│ Entry Signal • New York City                                             │
├──────────────────────────────────────────────────────────────────────────┤
│ Price            $0.230                                                  │
│ Size             $30.00 (15.0% of balance)                               │
│ Stop loss        $0.184 (20%)                                            │
╰──────────────────────────────────────────────────────────────────────────╯
```

---

## ⚠️ Risk Disclaimer

This software is provided **as-is**, without warranty. Prediction markets involve substantial risk of loss.

**Always:**
- Test with paper trading first
- Start with small amounts ($50-100)
- Never risk more than you can afford to lose
- Use stop losses (already built-in)

---

## 🔧 Troubleshooting

### Error: `Cannot read properties of null`

**Solution:** Run `npm run db-reset` to reset SQLite database.

### Error: `no such column "balance"`

**Solution:** Delete `data/live.db` and run `npm run db-reset`.

### Bot not opening positions

**Solution:** Check `ENTRY_THRESHOLD` in `.env` - try increasing to `0.30` if market prices are high.

### Live trading not working

**Solution:** Verify:
- USDC balance in wallet (`npm run execute` shows balance)
- Private key is correct (64 hex characters with 0x prefix)
- Proxy wallet address is correct

---

## 📝 Change Log

### Version 2.0 (April 2026)

- ✅ Migrated from JSON to **SQLite database** (no more corruption)
- ✅ Added **Kelly Criterion** position sizing
- ✅ Added **Stop Loss (20%)** and **Trailing Stop**
- ✅ Added **30+ global cities** (Open-Meteo API)
- ✅ Added **Ensemble Forecast** (31-member GFS)
- ✅ Added **Expected Value (EV) filtering**
- ✅ Fixed unit conversion (°F/°C for international cities)
- ✅ Added `--db-reset` command
- ✅ Improved error handling

### Version 1.0 (March 2026)

- Initial release with NWS forecast (US only)
- Paper trading with JSON state
- Basic entry/exit thresholds

---

## 📄 License

MIT

---

## 🙏 Acknowledgments

- [Polymarket CLOB](https://docs.polymarket.com/) for trading infrastructure
- [Open-Meteo](https://open-meteo.com/) for free global weather API
- [@polymarket/clob-client](https://www.npmjs.com/package/@polymarket/clob-client) for TypeScript SDK

---

**Built with ❤️ for Polymarket weather markets**

*Last updated: April 2026*
