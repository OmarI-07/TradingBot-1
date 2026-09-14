Skip to content
OmarI-07
TradingBot-1
Repository navigation
Code
Issues
Pull requests
Agents
Actions
Projects
Security and quality
Insights
Settings
Files
Go to file
t
T
.github
api
research
server
src
components
AccountPanel.jsx
BacktestResults.jsx
CandlestickChart.jsx
ConfluencePanel.jsx
ErrorBoundary.jsx
EvalDashboard.jsx
FeedbackLoop.jsx
HypothesisLab.jsx
IVWallsPanel.jsx
LearningDashboard.jsx
LearningPanel.jsx
LiveMode.jsx
PatternResearch.jsx
SignalDiagnostics.jsx
StrategyInput.jsx
StrategyReview.jsx
TradeChart.jsx
TradeJournal.jsx
research
App.jsx
account.js
backtest.js
claude.js
databento.js
exportTradesForML.js
index.css
indicators.js
learningHistory.js
main.jsx
marketRegime.js
massiveFinance.js
optimizer.js
paperBroker.js
pineScriptExporter.js
riskEngine.js
smc.js
strategyStorage.js
strategyVersioning.js
supabase.js
tradeMemory.js
volatility.js
yahooFinance.js
trading-bridge
.gitignore
README.md
RESEARCH-MANIFEST.json
RESEARCH.md
index.html
package-lock.json
package.json
railway.toml
vercel.json
vite.config.js
TradingBot-1/src/components
/
HypothesisLab.jsx
in
main

Edit

Preview
Indent mode

Spaces
Indent size

2
Line wrap mode

No wrap
Editing HypothesisLab.jsx file contents

  1
  2
  3
  4
  5
  6
  7
  8
  9
 10
 11
 12
 13
 14
 15
 16
 17
 18
 19
 20
 21
 22
 23
 24
 25
 26
 27
 28
 29
 30
 31
 32
 33
 34
 35
 36
 37
 38
 39
 40
 41
 42
 43
 44
 45
 46
 47
 48
 49
 50
 51
 52
 53
 54
 55
 56
 57
 58
 59
 60
 61
 62
// ── HypothesisLab.jsx ─────────────────────────────────────────────
// Standalone research harness for testing trading hypotheses.
//
// DELIBERATELY ISOLATED from backtest.js / claude.js / smc.js / indicators.js
// / tradeMemory.js / riskEngine.js / server/bot.js. The only thing it shares
// with the rest of the app is raw candle fetching (pure IO, no signal logic).
//
// Rules this file follows, on purpose:
//  - No AI-generated signals. Every hypothesis below is hand-written.
//  - No confluence stacking, no score system, no factors object.
//  - No session-threshold logic baked into any single hypothesis's entry
//    rule — session is measured as a RESULT (the per-session breakdown
//    below), not assumed as an input, so a session router only gets built
//    if the data actually shows a session-specific edge worth routing on.
//  - Every trade pays commission + slippage — a zero-cost backtest is the
//    same category of error as the look-ahead bias that inflated the
//    original signal to a fake 68% win rate. See "Friction model" below.
//  - Train / Validate / Test months are picked explicitly and separately —
//    there is no way to accidentally run Test data early.
//  - Rolling walk-forward runs every hypothesis on each month independently
//    (fixed rules, nothing fit per-window) and stitches the out-of-sample
//    months into one equity curve — "worked in 2 of 8 months" is a much
//    stronger answer than a single train/validate/test split.
//  - Nothing here writes to Supabase, active_strategy, or paper_trades.
//    This never touches what the live bot reads.
//
// Workflow: pick months for Train / Validate / Test, hit Run, read the table
// AND the per-session breakdown underneath it. Then separately pick a run
// of months for Rolling Walk-Forward. Phase 1 pass bar (editable below):
// min 25 trades AND expectancy ≥ +0.05R on TRAIN, measured after friction.
//
// The per-session breakdown exists to answer one question honestly: does
// any hypothesis actually perform differently by session, on real numbers —
// or would a "session router" just be reshuffling noise? Only build the
// router (a new composite entry in HYPOTHESES, tested through the same
// pipeline as everything else) if this breakdown shows a real difference,
// not a guess.

import { useState } from 'react'
import { fetchSelectedMonths, FUTURES_SYMBOLS, getAvailableMonths } from '../massiveFinance'

// ── Fixed engine constants — same across every hypothesis, on purpose ──
// (so any difference in results is due to the hypothesis, not the risk rules)
const POINT_VALUE      = 2      // $ per point, MNQ micro contract
const MAX_LOSS_DOLLARS = 500    // hard per-trade risk cap
const R_MULTIPLE       = 2      // fixed take-profit distance, in R
const STOP_ATR_MULT    = 1.5    // stop distance = 1.5 × ATR(14)
const COOLDOWN_BARS    = 3      // bars to wait after any exit before a new entry
const MAX_HOLD_BARS    = 75     // hard time-stop if neither target nor stop hit

// ── Friction model ───────────────────────────────────────────────
// A backtest with zero commission and perfect fills is silently too good on
// every single trade, in a fixed direction. This is the same category of
// error as look-ahead bias — it makes a hypothesis look tradeable when real
// costs would kill it. These numbers are deliberately on the cheap end for
// micro futures (low-cost futures broker), not worst-case — if a hypothesis
// can't survive even these, it has no real edge.
const TICK_SIZE             = 0.25  // MNQ tick size, points
const COMMISSION_PER_SIDE   = 0.74  // $ per contract per side (round trip = ×2)
const SLIPPAGE_ENTRY_TICKS  = 1     // normal market-order fill, worse than intended
const SLIPPAGE_STOP_TICKS   = 2     // stops slip more — filled during an adverse fast move
const SLIPPAGE_TARGET_TICKS = 1     // similar to entry — still a market fill, smaller slip
Use Control + Shift + m to toggle the tab key moving focus. Alternatively, use esc then tab to move to the next interactive element on the page.
 
