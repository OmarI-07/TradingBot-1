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

// A buy always fills slightly higher than intended; a sell always fills
// slightly lower. isBuyAction = true for the fill itself (long entry or
// short exit is a buy; short entry or long exit is a sell) — not the
// position side.
function slip(price, isBuyAction, ticks) {
  const amt = ticks * TICK_SIZE
  return isBuyAction ? price + amt : price - amt
}

// Phase 1 gate — a hypothesis must clear this on TRAIN before it's even
// shown as a Validate/Test candidate. Sample-size floor matters: a 70% win
// rate on 8 trades is noise, not edge. Measured after friction.
const PASS_BAR = { minTrades: 25, minExpectancyR: 0.05 }

// ── Decision Policy gate (Stage X) ───────────────────────────────
// A hypothesis firing is a forecast (Stage IX) — direction and a stop
// distance, not yet a trade. Stage X asks one narrower, non-circular
// question before acting: is the KNOWN cost of this specific trade
// (commission + worst-case slippage, in points) small enough relative to
// its stop distance that a real edge could still survive it? This is
// decidable in advance without knowing the hypothesis's true win rate —
// unlike "is this a good trade," "is this cost too large a bite out of 1R"
// doesn't depend on the outcome. In quiet/low-ATR conditions the stop
// tightens and friction eats a bigger share of it; this gate blocks those
// specific trades rather than letting every hypothesis quietly eat that
// cost. At normal NQ volatility (ATR roughly 8-30 on 5-min bars) this gate
// stays out of the way entirely — it should only fire during genuinely
// dead-quiet stretches.
const MAX_FRICTION_TO_R_RATIO = 0.15  // block if friction cost > 15% of stop distance

const SYMBOL = 'NQ'
const AVAILABLE_MONTHS = getAvailableMonths(30)

// ── Session buckets ───────────────────────────────────────────────
// Same UTC hour boundaries already used elsewhere in this codebase
// (server/bot.js sessionName logic) so results are comparable.
const SESSIONS = ['London', 'New York', 'Asian', 'Offhours']
function getSession(t) {
  const h = utcHour(t)
  if (h >= 7  && h < 12) return 'London'
  if (h >= 13 && h < 21) return 'New York'
  if (h >= 23 || h < 4)  return 'Asian'
  return 'Offhours'
}
function summarizeBySession(trades) {
  const out = {}
  for (const s of SESSIONS) out[s] = summarize(trades.filter((t) => getSession(t.time) === s))
  return out
}

// ── Rollover / data-quality check ────────────────────────────────
// A jump of >1.5% between two candles only ~5-10 minutes apart is not
// normal price action — it's the signature of an un-stitched futures
// contract roll (e.g. MNQU2026 → MNQZ2026) sitting in the raw data. This
// doesn't fix massiveFinance.js, it just tells you if you need to check it
// before trusting any result run on these months.
function detectSuspiciousGaps(candles) {
  const gaps = []
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close
    const curOpen = candles[i].open
    const timeDiffMin = (candles[i].time - candles[i - 1].time) / 60000
    if (timeDiffMin > 10) continue // real session/weekend gap, not what we're checking for
    const pctMove = Math.abs(curOpen - prevClose) / prevClose * 100
    if (pctMove > 1.5) gaps.push({ time: candles[i].time, pctMove: +pctMove.toFixed(2) })
  }
  return gaps
}

// ── Minimal, self-contained indicators (no shared code with indicators.js) ──
function calcATR(candles, i, period = 14) {
  const start = Math.max(1, i - period + 1)
  let sum = 0, n = 0
  for (let k = start; k <= i; k++) {
    const tr = Math.max(
      candles[k].high - candles[k].low,
      Math.abs(candles[k].high - candles[k - 1].close),
      Math.abs(candles[k].low  - candles[k - 1].close),
    )
    sum += tr; n++
  }
  return n > 0 ? sum / n : (candles[i].high - candles[i].low)
}

function calcEMASeries(candles, period) {
  const k = 2 / (period + 1)
  const out = new Array(candles.length).fill(null)
  let sum = 0
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close
    if (i < period - 1) continue
    if (i === period - 1) { out[i] = sum / period; continue }
    out[i] = candles[i].close * k + out[i - 1] * (1 - k)
  }
  return out
}

function calcSMASeries(candles, period) {
  const out = new Array(candles.length).fill(null)
  let sum = 0
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close
    if (i >= period) sum -= candles[i - period].close
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

const utcHour   = (t) => new Date(t).getUTCHours()
const utcMinute = (t) => new Date(t).getUTCMinutes()
const dayKey    = (t) => new Date(t).toISOString().slice(0, 10)

// ── The hypotheses ───────────────────────────────────────────────
// Each is `makeSignal(candles) => (i) => 'buy' | 'sell' | 'none'`.
// makeSignal runs once per backtest (lets a hypothesis precompute things
// like EMAs); the returned function is called once per bar. Any internal
// state (today's range, whether it already fired, etc.) lives in the
// closure and is fresh every time makeSignal is called — so nothing leaks
// between Train / Validate / Test / walk-forward month runs.

function baselineMomentum(candles, i) {
  if (i < 3) return 'none'
  if (candles[i].close > candles[i - 1].close && candles[i - 1].close > candles[i - 2].close) return 'buy'
  if (candles[i].close < candles[i - 1].close && candles[i - 1].close < candles[i - 2].close) return 'sell'
  return 'none'
}

const HYPOTHESES = [
  {
    id: 'h1_orb',
    name: 'H1 — Opening Range Breakout',
    description: 'First 30 min of NY session (13:00–13:30 UTC) sets a range. Close beyond it → trade the breakout direction, once per day.',
    makeSignal: (candles) => {
      let day = null, rangeHigh = -Infinity, rangeLow = Infinity, fired = false
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== day) { day = d; rangeHigh = -Infinity; rangeLow = Infinity; fired = false }
        const h = utcHour(c.time), m = utcMinute(c.time)
        if (h === 13 && m < 30) {
          rangeHigh = Math.max(rangeHigh, c.high)
          rangeLow  = Math.min(rangeLow, c.low)
          return 'none'
        }
        if (fired || rangeHigh === -Infinity) return 'none'
        if (c.close > rangeHigh) { fired = true; return 'buy' }
        if (c.close < rangeLow)  { fired = true; return 'sell' }
        return 'none'
      }
    },
  },
  {
    id: 'h2_pdh_pdl_sweep',
    name: 'H2 — PDH/PDL Sweep Reversal',
    description: 'Price wicks beyond yesterday\u2019s high/low and closes back inside, same bar. Real resting liquidity, not a generic 5-bar swing.',
    makeSignal: (candles) => {
      let curDay = null, curHigh = null, curLow = null, pdh = null, pdl = null
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== curDay) {
          if (curDay !== null) { pdh = curHigh; pdl = curLow }
          curDay = d; curHigh = c.high; curLow = c.low
        } else {
          curHigh = Math.max(curHigh, c.high)
          curLow  = Math.min(curLow, c.low)
        }
        if (pdh == null || pdl == null) return 'none'
        if (c.low  < pdl && c.close > pdl) return 'buy'
        if (c.high > pdh && c.close < pdh) return 'sell'
        return 'none'
      }
    },
  },
  {
    id: 'h8_ma_cross_session',
    name: "H8 \u2014 21-EMA Cross, 7am\u201312pm ET",
    description: "From an outside source (Reddit, unverified track record) describing a live prop-firm bot: price closes past a moving average on the 5-min chart, traded only 'premarket and a bit after opening bell' through 'flat by 12pm EST', NY/premarket only, never 24/7. Interpreted here as: price crosses (not just sits above/below) a 21-period EMA, gated to 7:00am\u201312:00pm ET (12:00\u201317:00 UTC, fixed EST offset matching this Lab\u0027s existing session convention). The window claim has independent support in this Lab\u0027s own data (session and time-of-day findings elsewhere favoring NY/late-morning); the entry rule itself closely resembles H3a/H5, both of which failed here \u2014 tested fresh, not trusted on the source\u0027s say-so.",
    makeSignal: (candles) => {
      const ema = calcEMASeries(candles, 21)
      return (i) => {
        if (i < 22) return 'none'
        const h = utcHour(candles[i].time)
        if (h < 12 || h >= 17) return 'none'
        if (ema[i] == null || ema[i - 1] == null) return 'none'
        const prevClose = candles[i - 1].close, curClose = candles[i].close
        if (prevClose <= ema[i - 1] && curClose > ema[i]) return 'buy'
        if (prevClose >= ema[i - 1] && curClose < ema[i]) return 'sell'
        return 'none'
      }
    },
  },
  {
    id: 'h8b_ma_cross_premarket_narrow',
    name: "H8b \u2014 21-EMA Cross, 7\u201310:30am ET (corrected window)",
    description: "Corrects a real translation error in H8: the source said entries happen 'premarket and a bit after opening bell,' separately from 'flat by 12pm EST' \u2014 two different claims (when to enter vs. how long to hold), which H8 incorrectly merged into one wide 7am\u201312pm entry window. This narrows entries to 7:00\u201310:30am ET (12:00\u201315:30 UTC, premarket through shortly after the 9:30am open) using the same 21-EMA cross and standard exit logic as H8. Treated as the final disciplined check on this source \u2014 MA period/type were never stated by the source at all and aren\u2019t worth further guessing given this whole category (H3a, H3b, H5) has already failed here.",
    makeSignal: (candles) => {
      const ema = calcEMASeries(candles, 21)
      return (i) => {
        if (i < 22) return 'none'
        const h = utcHour(candles[i].time), m = utcMinute(candles[i].time)
        const afterStart = h >= 12
        const beforeEnd = h < 15 || (h === 15 && m === 0)
        if (!(afterStart && beforeEnd)) return 'none'
        if (ema[i] == null || ema[i - 1] == null) return 'none'
        const prevClose = candles[i - 1].close, curClose = candles[i].close
        if (prevClose <= ema[i - 1] && curClose > ema[i]) return 'buy'
        if (prevClose >= ema[i - 1] && curClose < ema[i]) return 'sell'
        return 'none'
      }
    },
  },
  {
    id: 'h9_sweep_asian_atrfloor',
    name: "H9 \u2014 PDH/PDL Sweep, Asian Session + ATR Floor",
    description: "Built directly from the Combination Grid's (Section 7) top result: H2's sweep event, restricted to the Asian session, gated to ATR(14) > 33.33 \u2014 identical logic to what the grid tested, not a re-derivation. The grid's own result had two real concerns: only 13 trades (well under this Lab's usual 25-trade floor) and a p-value of 5.0% resting on a single permutation out of 20, the thinnest possible margin that test can produce. Also worth flagging: Asian session showed up as a standout on H2's own session breakdown once before, at similarly small sample size, and nothing built from that lead survived further testing. Tested fresh, on a wide month range, expecting it may well fail given both the trade count and the pattern-match to a prior false lead.",
    makeSignal: (candles) => {
      let curDay = null, curHigh = null, curLow = null, pdh = null, pdl = null
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== curDay) {
          if (curDay !== null) { pdh = curHigh; pdl = curLow }
          curDay = d; curHigh = c.high; curLow = c.low
        } else {
          curHigh = Math.max(curHigh, c.high)
          curLow  = Math.min(curLow, c.low)
        }
        if (pdh == null || pdl == null) return 'none'
        if (getSession(c.time) !== 'Asian') return 'none'
        if (calcATR(candles, i) <= 33.33) return 'none'
        if (c.low  < pdl && c.close > pdl) return 'buy'
        if (c.high > pdh && c.close < pdh) return 'sell'
        return 'none'
      }
    },
  },
  {
    id: 'h2c_sweep_trend_aligned',
    name: 'H2c — PDH/PDL Sweep, Trend-Aligned',
    description: 'Identical event to H2, but only takes the trade when its direction agrees with the prevailing trend at that moment (5-bar % change of 20-SMA): bullish sweep only taken during an uptrend, bearish sweep only taken during a downtrend. Built from the Event Context Explorer\u0027s trend-steepness breakdown on H2\u0027s own event \u2014 steepest-downtrend quintile was significantly negative (CI cleared zero), steepest-uptrend quintile was the only positive mean in that table. Tests the direction-aware version of that finding, not a single arbitrary bucket.',
    makeSignal: (candles) => {
      const sma20 = calcSMASeries(candles, 20)
      let curDay = null, curHigh = null, curLow = null, pdh = null, pdl = null
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== curDay) {
          if (curDay !== null) { pdh = curHigh; pdl = curLow }
          curDay = d; curHigh = c.high; curLow = c.low
        } else {
          curHigh = Math.max(curHigh, c.high)
          curLow  = Math.min(curLow, c.low)
        }
        if (pdh == null || pdl == null) return 'none'

        let trendSteepness = 0
        if (i >= 5 && sma20[i] != null && sma20[i - 5] != null && sma20[i - 5] !== 0) {
          trendSteepness = (sma20[i] - sma20[i - 5]) / sma20[i - 5]
        }

        if (c.low  < pdl && c.close > pdl && trendSteepness > 0) return 'buy'
        if (c.high > pdh && c.close < pdh && trendSteepness < 0) return 'sell'
        return 'none'
      }
    },
  },
  {
    id: 'h2d_sweep_trend_atr_wick',
    name: 'H2d — PDH/PDL Sweep, Trend + High ATR + Small Wick',
    description: "H2c\u2019s trend-alignment gate, now also requiring ATR(14) \u2265 22pts and wick ratio \u2264 0.25 on the event candle \u2014 the exact combination the Event Context Explorer\u2019s joint breakdown showed as the widest split in the whole dataset: Uptrend/High ATR/Small Wick was +0.225R (n=202, CI clears zero positive) while Downtrend/High ATR/Small Wick was -0.360R (n=222, CI clears zero negative), same ATR and wick bucket, only trend direction differing. Thresholds are fixed, round numbers approximating the exploratory median split \u2014 not further tuned to this specific dataset. H2c alone already failed Train; this tests whether the narrower, ATR+wick-qualified version is what H2c\u2019s broader gate was diluting, or whether this is the one good-looking cell out of eight the joint table\u2019s own warning is about.",
    makeSignal: (candles) => {
      const sma20 = calcSMASeries(candles, 20)
      const ATR_THRESHOLD  = 22
      const WICK_THRESHOLD = 0.25
      let curDay = null, curHigh = null, curLow = null, pdh = null, pdl = null
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== curDay) {
          if (curDay !== null) { pdh = curHigh; pdl = curLow }
          curDay = d; curHigh = c.high; curLow = c.low
        } else {
          curHigh = Math.max(curHigh, c.high)
          curLow  = Math.min(curLow, c.low)
        }
        if (pdh == null || pdl == null) return 'none'

        let trendSteepness = 0
        if (i >= 5 && sma20[i] != null && sma20[i - 5] != null && sma20[i - 5] !== 0) {
          trendSteepness = (sma20[i] - sma20[i - 5]) / sma20[i - 5]
        }
        const atr   = calcATR(candles, i)
        const range = c.high - c.low

        if (c.low < pdl && c.close > pdl) {
          const lowerWick = Math.min(c.open, c.close) - c.low
          const wickRatio = range > 0 ? lowerWick / range : 0
          if (trendSteepness > 0 && atr >= ATR_THRESHOLD && wickRatio <= WICK_THRESHOLD) return 'buy'
        }
        if (c.high > pdh && c.close < pdh) {
          const upperWick = c.high - Math.max(c.open, c.close)
          const wickRatio = range > 0 ? upperWick / range : 0
          if (trendSteepness < 0 && atr >= ATR_THRESHOLD && wickRatio <= WICK_THRESHOLD) return 'sell'
        }
        return 'none'
      }
    },
  },
  {
    id: 'h2e_sweep_trend_atr_wick_ny',
    name: "H2e \u2014 H2d, New York session only",
    description: "H2d\u2019s trend + ATR + wick gate, additionally restricted to the New York session (13:00\u201321:00 UTC) \u2014 the one session with a real sample size (48 trades) that looked best in H2d\u0027s Train run (+0.169R). Treated with the same suspicion as every prior session-narrowing attempt in this Lab (H5b, H7b, H3c\u0027s London), all of which looked promising on one Train run and failed on wide walk-forward. Train result here should not be trusted either way \u2014 only walk-forward on a wide month range answers whether this holds up.",
    makeSignal: (candles) => {
      const sma20 = calcSMASeries(candles, 20)
      const ATR_THRESHOLD  = 22
      const WICK_THRESHOLD = 0.25
      let curDay = null, curHigh = null, curLow = null, pdh = null, pdl = null
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== curDay) {
          if (curDay !== null) { pdh = curHigh; pdl = curLow }
          curDay = d; curHigh = c.high; curLow = c.low
        } else {
          curHigh = Math.max(curHigh, c.high)
          curLow  = Math.min(curLow, c.low)
        }
        if (pdh == null || pdl == null) return 'none'
        if (getSession(c.time) !== 'New York') return 'none'

        let trendSteepness = 0
        if (i >= 5 && sma20[i] != null && sma20[i - 5] != null && sma20[i - 5] !== 0) {
          trendSteepness = (sma20[i] - sma20[i - 5]) / sma20[i - 5]
        }
        const atr   = calcATR(candles, i)
        const range = c.high - c.low

        if (c.low < pdl && c.close > pdl) {
          const lowerWick = Math.min(c.open, c.close) - c.low
          const wickRatio = range > 0 ? lowerWick / range : 0
          if (trendSteepness > 0 && atr >= ATR_THRESHOLD && wickRatio <= WICK_THRESHOLD) return 'buy'
        }
        if (c.high > pdh && c.close < pdh) {
          const upperWick = c.high - Math.max(c.open, c.close)
          const wickRatio = range > 0 ? upperWick / range : 0
          if (trendSteepness < 0 && atr >= ATR_THRESHOLD && wickRatio <= WICK_THRESHOLD) return 'sell'
        }
        return 'none'
      }
    },
  },
  {
    id: 'h3a_momentum_any',
    name: 'H3a — Momentum baseline (any time)',
    description: 'Simple 2-bar momentum entry, no time restriction. Baseline to compare H3b against — tests whether session alone changes the result.',
    makeSignal: (candles) => (i) => baselineMomentum(candles, i),
  },
  {
    id: 'h3b_momentum_ny',
    name: 'H3b — Momentum, NY session only',
    description: 'Identical rule to H3a, restricted to 13:00–21:00 UTC. If this beats H3a, session timing carries real signal on its own.',
    makeSignal: (candles) => (i) => {
      const h = utcHour(candles[i].time)
      if (h < 13 || h >= 21) return 'none'
      return baselineMomentum(candles, i)
    },
  },
  {
    id: 'h3c_momentum_atr_floor',
    name: 'H3c — Momentum, ATR floor (>33pts)',
    description: 'Identical entry rule to H3a, gated to only fire when ATR(14) at entry exceeds ~33 points — the exact boundary where this Lab\'s own $500-cap sizing formula switches from 5-6 contracts to 4 or fewer. A bottom-up review of H3a\'s real trade output found the 5-6-contract regime (low ATR) lost $45,765 across 1,124 trades while the 1-4-contract regime (higher ATR) made +$22,130 across 280 trades — not a coincidence, since low ATR IS what forces the sizing formula to the cap. Tests whether that is a genuine volatility-regime effect on the entry itself, not just an artifact of position sizing.',
    makeSignal: (candles) => (i) => {
      if (i < 20) return 'none'
      const atr = calcATR(candles, i)
      if (atr <= 33.33) return 'none'
      return baselineMomentum(candles, i)
    },
  },
  {
    id: 'h4_gap_fade',
    name: 'H4 — Gap Fade',
    description: 'First bar of a new day: if open gaps > 1.5\u00d7ATR from prior close, fade back toward it.',
    makeSignal: (candles) => (i) => {
      if (i < 20) return 'none'
      if (dayKey(candles[i].time) === dayKey(candles[i - 1].time)) return 'none'
      const prevClose = candles[i - 1].close
      const gap = candles[i].open - prevClose
      const atr = calcATR(candles, i - 1)
      if (Math.abs(gap) < atr * 1.5) return 'none'
      return gap > 0 ? 'sell' : 'buy'
    },
  },
  {
    id: 'h5_ema_pullback',
    name: 'H5 — EMA Stack Pullback',
    description: '9/21/50 EMA stacked in trend order, price pulls back to the 21 EMA and reclaims it same bar \u2192 trade continuation.',
    makeSignal: (candles) => {
      const ema9  = calcEMASeries(candles, 9)
      const ema21 = calcEMASeries(candles, 21)
      const ema50 = calcEMASeries(candles, 50)
      return (i) => {
        if (ema50[i] == null) return 'none'
        const bull = ema9[i] > ema21[i] && ema21[i] > ema50[i]
        const bear = ema9[i] < ema21[i] && ema21[i] < ema50[i]
        const c = candles[i]
        if (bull && c.low  <= ema21[i] && c.close > ema21[i]) return 'buy'
        if (bear && c.high >= ema21[i] && c.close < ema21[i]) return 'sell'
        return 'none'
      }
    },
  },
  {
    id: 'h5b_ema_pullback_offhours',
    name: 'H5b — EMA Stack Pullback, Offhours only',
    description: 'Identical entry rule to H5, restricted to the Offhours bucket (04:00–07:00, 12:00–13:00, 21:00–23:00 UTC) — the one session where H5 showed a consistent edge on BOTH Train and walk-forward. Tested as its own hypothesis, not assumed.',
    makeSignal: (candles) => {
      const ema9  = calcEMASeries(candles, 9)
      const ema21 = calcEMASeries(candles, 21)
      const ema50 = calcEMASeries(candles, 50)
      return (i) => {
        if (getSession(candles[i].time) !== 'Offhours') return 'none'
        if (ema50[i] == null) return 'none'
        const bull = ema9[i] > ema21[i] && ema21[i] > ema50[i]
        const bear = ema9[i] < ema21[i] && ema21[i] < ema50[i]
        const c = candles[i]
        if (bull && c.low  <= ema21[i] && c.close > ema21[i]) return 'buy'
        if (bear && c.high >= ema21[i] && c.close < ema21[i]) return 'sell'
        return 'none'
      }
    },
  },
  {
    id: 'h6_vwap_reversion',
    name: 'H6 — VWAP Mean Reversion',
    description: 'Price > 2\u00d7ATR from session VWAP \u2192 fade back toward it. Skipped automatically if candles have no volume data.',
    makeSignal: (candles) => {
      const hasVolume = candles.some((c) => c.volume > 0)
      if (!hasVolume) return () => 'none'
      const vwapArr = new Array(candles.length).fill(null)
      let d = null, pv = 0, v = 0
      for (let k = 0; k < candles.length; k++) {
        const dk = dayKey(candles[k].time)
        if (dk !== d) { d = dk; pv = 0; v = 0 }
        const typical = (candles[k].high + candles[k].low + candles[k].close) / 3
        pv += typical * (candles[k].volume || 0)
        v  += (candles[k].volume || 0)
        vwapArr[k] = v > 0 ? pv / v : typical
      }
      return (i) => {
        if (i < 20 || vwapArr[i] == null) return 'none'
        const atr = calcATR(candles, i)
        const dev = candles[i].close - vwapArr[i]
        if (dev >  atr * 2) return 'sell'
        if (dev < -atr * 2) return 'buy'
        return 'none'
      }
    },
    needsVolumeCheck: true,
  },
  {
    id: 'h7_amd_asian_london',
    name: 'H7 — AMD: Asian Range \u2192 London Sweep',
    description: 'Asian session (23:00\u201304:00 UTC) range = accumulation. London/NY sweep of that range that closes back inside = manipulation \u2192 trade the reversal.',
    makeSignal: (candles) => {
      let day = null, asianHigh = -Infinity, asianLow = Infinity, fired = false
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== day) { day = d; asianHigh = -Infinity; asianLow = Infinity; fired = false }
        const h = utcHour(c.time)
        const inAsian = h >= 23 || h < 4
        if (inAsian) {
          asianHigh = Math.max(asianHigh, c.high)
          asianLow  = Math.min(asianLow, c.low)
          return 'none'
        }
        if (asianHigh === -Infinity || fired) return 'none'
        const inLondonOrNY = h >= 7 && h < 21
        if (!inLondonOrNY) return 'none'
        if (c.low  < asianLow  && c.close > asianLow)  { fired = true; return 'buy' }
        if (c.high > asianHigh && c.close < asianHigh) { fired = true; return 'sell' }
        return 'none'
      }
    },
  },
  {
    id: 'h7b_amd_london_only',
    name: 'H7b — AMD: Asian Range \u2192 London Sweep, London only',
    description: 'Identical entry rule to H7, restricted to the London session (07:00\u201312:00 UTC) for the sweep/reversal entry \u2014 the session where H7 showed a consistent edge on BOTH Train and walk-forward. Tested as its own hypothesis, not assumed.',
    makeSignal: (candles) => {
      let day = null, asianHigh = -Infinity, asianLow = Infinity, fired = false
      return (i) => {
        const c = candles[i]
        const d = dayKey(c.time)
        if (d !== day) { day = d; asianHigh = -Infinity; asianLow = Infinity; fired = false }
        const h = utcHour(c.time)
        const inAsian = h >= 23 || h < 4
        if (inAsian) {
          asianHigh = Math.max(asianHigh, c.high)
          asianLow  = Math.min(asianLow, c.low)
          return 'none'
        }
        if (asianHigh === -Infinity || fired) return 'none'
        if (getSession(c.time) !== 'London') return 'none'
        if (c.low  < asianLow  && c.close > asianLow)  { fired = true; return 'buy' }
        if (c.high > asianHigh && c.close < asianHigh) { fired = true; return 'sell' }
        return 'none'
      }
    },
  },
]

// ── Event Context Explorer ───────────────────────────────────────
// A different tool from the hypothesis tester above, on purpose. Every
// hypothesis (H1-H3c) fused "is this bar worth studying" and "should I
// trade it" into one rule, then tested that fused rule directly — which
// is why session/ATR narrowing after the fact (H5b, H7b, H3c) kept
// producing the same Train-looks-good-walk-forward-fails pattern: a single
// binary split chosen by looking at which subset performed best is close
// to picking the answer before running the experiment.
//
// This tool keeps three things explicitly separate, the way real feature
// engineering does:
//   1. EVENT  — just a timestamp flag ("this bar is worth studying"),
//      not a trade decision. Uses the same PDH/PDL sweep as H2, but
//      detected on its own with no entry logic attached.
//   2. CONTEXTUAL FEATURES — continuous, measured variables that might
//      explain why the same event produces different outcomes at
//      different times. The three built in here are exactly the ones a
//      trader's "discretion" usually already weighs without naming them:
//      recent range (ATR), wick size on the event candle, and trend
//      steepness (normalized moving-average slope). The point of this
//      tool is to quantify those instead of trusting the gut feeling.
//   3. OUTCOME — the same double-barrier method (ATR-based stop/target,
//      same friction model) used everywhere else in this Lab.
//
// The output is a full quantile breakdown per feature — 5 buckets, each
// with sample size, mean R, and a 95% confidence interval — not a single
// chosen threshold. A real contextual relationship should show buckets
// separating with non-overlapping (or clearly trending) confidence
// intervals across a reasonable sample size per bucket. One bucket
// looking best is not evidence on its own — that is exactly the mistake
// that broke H7b: London looked like the standout bucket in one Train
// run and failed to hold up walk-forward.

function detectSweepEvents(candles) {
  const events = []
  let curDay = null, curHigh = null, curLow = null, pdh = null, pdl = null
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const d = dayKey(c.time)
    if (d !== curDay) {
      if (curDay !== null) { pdh = curHigh; pdl = curLow }
      curDay = d; curHigh = c.high; curLow = c.low
    } else {
      curHigh = Math.max(curHigh, c.high)
      curLow  = Math.min(curLow, c.low)
    }
    if (pdh == null || pdl == null) continue
    if (c.low  < pdl && c.close > pdl) events.push({ idx: i, direction: 'bullish' })
    if (c.high > pdh && c.close < pdh) events.push({ idx: i, direction: 'bearish' })
  }
  return events
}

function contextualFeatures(candles, sma20, idx, direction) {
  const c = candles[idx]
  const recentRange = calcATR(candles, idx) // "recent range"

  const range = c.high - c.low
  let wickSize
  if (direction === 'bullish') {
    const lowerWick = Math.min(c.open, c.close) - c.low
    wickSize = range > 0 ? lowerWick / range : 0
  } else {
    const upperWick = c.high - Math.max(c.open, c.close)
    wickSize = range > 0 ? upperWick / range : 0
  }

  // Trend steepness: normalized 5-bar rate of change of a 20-SMA, in
  // percentage terms so it stays scale-free across different price levels
  // (a raw dollar slope would look different on NQ at 15,000 vs 22,000).
  let trendSteepness = 0
  if (idx >= 5 && sma20[idx] != null && sma20[idx - 5] != null && sma20[idx - 5] !== 0) {
    trendSteepness = (sma20[idx] - sma20[idx - 5]) / sma20[idx - 5]
  }

  return { recentRange, wickSize, trendSteepness }
}

function simulateEventOutcome(candles, eventIdx, direction) {
  const side = direction === 'bullish' ? 'long' : 'short'
  const atr  = calcATR(candles, eventIdx)
  const dist = atr * STOP_ATR_MULT
  if (dist <= 0) return null
  const rawEntry   = candles[eventIdx].close
  const entryPrice = slip(rawEntry, side === 'long', SLIPPAGE_ENTRY_TICKS)
  const stopPrice   = side === 'long' ? entryPrice - dist : entryPrice + dist
  const targetPrice = side === 'long' ? entryPrice + dist * R_MULTIPLE : entryPrice - dist * R_MULTIPLE

  for (let i = eventIdx + 1; i < Math.min(candles.length, eventIdx + 1 + MAX_HOLD_BARS); i++) {
    const c = candles[i]
    let rawExit = null, exitIsBuy = null
    if (side === 'long') {
      if (c.low <= stopPrice)        { rawExit = stopPrice;   exitIsBuy = false }
      else if (c.high >= targetPrice) { rawExit = targetPrice; exitIsBuy = false }
    } else {
      if (c.high >= stopPrice)       { rawExit = stopPrice;   exitIsBuy = true }
      else if (c.low <= targetPrice)  { rawExit = targetPrice; exitIsBuy = true }
    }
    if (rawExit != null) {
      const slipTicks = rawExit === stopPrice ? SLIPPAGE_STOP_TICKS : SLIPPAGE_TARGET_TICKS
      const exitPrice = slip(rawExit, exitIsBuy, slipTicks)
      const dir = side === 'long' ? 1 : -1
      const stopDist = Math.abs(entryPrice - stopPrice)
      const contracts = stopDist > 0
        ? Math.max(1, Math.min(6, Math.floor(MAX_LOSS_DOLLARS / (stopDist * POINT_VALUE))))
        : 1
      const grossPnl   = dir * (exitPrice - entryPrice) * POINT_VALUE * contracts
      const commission = COMMISSION_PER_SIDE * 2 * contracts
      const dollarPnl  = grossPnl - commission
      const rMult      = stopDist > 0 ? dir * (exitPrice - entryPrice) / stopDist : 0
      return { rMult, dollarPnl }
    }
  }
  return null // neither barrier hit within MAX_HOLD_BARS
}

function quantileBuckets(items, valueKey, k = 5) {
  const sorted   = [...items].sort((a, b) => a[valueKey] - b[valueKey])
  const bucketed = Array.from({ length: k }, () => [])
  sorted.forEach((item, i) => {
    const bucketIdx = Math.min(k - 1, Math.floor((i / sorted.length) * k))
    bucketed[bucketIdx].push(item)
  })
  return bucketed.map((bucket) => {
    const n = bucket.length
    if (n === 0) return { n: 0, meanR: 0, ci95: 0, lower: 0, upper: 0, totalDollar: 0, featureRange: [0, 0], winRate: 0, winRateLower: 0, winRateUpper: 0 }
    const rMults    = bucket.map((b) => b.outcome.rMult)
    const mean      = rMults.reduce((a, b) => a + b, 0) / n
    const variance  = n > 1 ? rMults.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0
    const se        = Math.sqrt(variance / n)
    const ci95      = 1.96 * se
    const totalDollar = bucket.reduce((a, b) => a + b.outcome.dollarPnl, 0)
    const featureVals = bucket.map((b) => b[valueKey])
    const wins     = bucket.filter((b) => b.outcome.dollarPnl > 0).length
    const wilson   = wilsonInterval(wins, n)
    return {
      n, meanR: +mean.toFixed(3), ci95: +ci95.toFixed(3),
      lower: +(mean - ci95).toFixed(3), upper: +(mean + ci95).toFixed(3),
      totalDollar: +totalDollar.toFixed(0),
      featureRange: [+Math.min(...featureVals).toFixed(4), +Math.max(...featureVals).toFixed(4)],
      winRate: +((wins / n) * 100).toFixed(1),
      winRateLower: +(wilson.lower * 100).toFixed(1),
      winRateUpper: +(wilson.upper * 100).toFixed(1),
    }
  })
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Joint (multivariate) breakdown — the univariate tables above test one
// feature at a time, which is exactly the mistake the feature-engineering
// video's height-prediction analogy warns against ("only asking where
// someone is from"). A real relationship may only show up in a specific
// COMBINATION of features, not in any one of them alone — e.g. trend
// alignment might only matter when volatility is also elevated. This
// splits each feature at its median (trend at zero, since up/down already
// has real meaning) and reports all 8 combinations together.
//
// Important: 8 buckets from the same data is MORE multiple-comparisons
// risk than 5 quantiles per feature, not less — with more, smaller cells,
// it is easier for one to look good by chance. One standout combination
// here is weaker evidence than a monotonic trend across quantiles was,
// not stronger — treat any single cell that looks good with real
// suspicion before building a hypothesis from it.
function jointBuckets(items) {
  const atrMedian  = median(items.map((i) => i.recentRange))
  const wickMedian = median(items.map((i) => i.wickSize))
  const groups = {}
  for (const item of items) {
    const atrLabel   = item.recentRange   >= atrMedian  ? 'High ATR'  : 'Low ATR'
    const wickLabel  = item.wickSize      >= wickMedian ? 'Big Wick'  : 'Small Wick'
    const trendLabel = item.trendSteepness >= 0          ? 'Uptrend'   : 'Downtrend'
    const key = `${trendLabel} / ${atrLabel} / ${wickLabel}`
    if (!groups[key]) groups[key] = []
    groups[key].push(item)
  }
  const results = Object.entries(groups).map(([label, bucket]) => {
    const n = bucket.length
    const rMults   = bucket.map((b) => b.outcome.rMult)
    const mean     = rMults.reduce((a, b) => a + b, 0) / n
    const variance = n > 1 ? rMults.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0
    const se       = Math.sqrt(variance / n)
    const ci95     = 1.96 * se
    const totalDollar = bucket.reduce((a, b) => a + b.outcome.dollarPnl, 0)
    const wins     = bucket.filter((b) => b.outcome.dollarPnl > 0).length
    const wilson   = wilsonInterval(wins, n)
    return {
      label, n, meanR: +mean.toFixed(3), ci95: +ci95.toFixed(3),
      lower: +(mean - ci95).toFixed(3), upper: +(mean + ci95).toFixed(3),
      totalDollar: +totalDollar.toFixed(0),
      winRate: +((wins / n) * 100).toFixed(1),
      winRateLower: +(wilson.lower * 100).toFixed(1),
      winRateUpper: +(wilson.upper * 100).toFixed(1),
    }
  })
  results.sort((a, b) => b.meanR - a.meanR)
  return results
}

// ── Monte Carlo permutation test ──────────────────────────────────
// Answers a different, more fundamental question than walk-forward does:
// not "did this hold up on unseen months" but "is this result even
// distinguishable from what a worthless rule could produce by chance on
// data with the same overall statistical shape." Preserves the price
// series' mean, stdev, skew, kurtosis, and overall drift (the exact first
// open and last close are mathematically guaranteed to match \u2014 shuffling
// a set of numbers never changes their sum) while destroying the actual
// sequential pattern \u2014 the trends, the specific highs/lows a sweep or
// ATR calculation depends on. If the real hypothesis's result isn't
// meaningfully better than what it produces on most of these permutations,
// the rule isn't capturing real sequential structure \u2014 whatever number
// it produced on real data is closer to noise than edge.
function permuteBars(candles, startIndex = 0) {
  const n = candles.length
  if (startIndex >= n - 2) return candles

  const relValues = []
  const gaps = []
  for (let i = startIndex + 1; i < n; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    const logOpen = Math.log(c.open)
    relValues.push({
      relHigh: Math.log(c.high) - logOpen,
      relLow: Math.log(c.low) - logOpen,
      relClose: Math.log(c.close) - logOpen,
    })
    gaps.push(logOpen - Math.log(prevClose))
  }

  function shuffle(arr) {
    const out = [...arr]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp
    }
    return out
  }

  const shuffledRel  = shuffle(relValues)
  const shuffledGaps = shuffle(gaps)

  const out = new Array(n)
  for (let i = 0; i <= startIndex; i++) out[i] = { ...candles[i] }

  let prevClose = candles[startIndex].close
  for (let k = 0; k < shuffledRel.length; k++) {
    const i = startIndex + 1 + k
    const logOpen = Math.log(prevClose) + shuffledGaps[k]
    const open  = Math.exp(logOpen)
    const high  = Math.exp(logOpen + shuffledRel[k].relHigh)
    const low   = Math.exp(logOpen + shuffledRel[k].relLow)
    const close = Math.exp(logOpen + shuffledRel[k].relClose)
    out[i] = { time: candles[i].time, open, high, low, close }
    prevClose = close
  }
  return out
}

function runPermutationTest(candles, hypothesis, numPermutations = 200) {
  const realFn = hypothesis.makeSignal(candles)
  const realTrades = runEngine(candles, realFn).trades
  const realStats = summarize(realTrades)
  const realMetric = realStats.expectancyR

  let asGoodOrBetter = 0
  const permMetrics = []
  for (let p = 0; p < numPermutations; p++) {
    const permuted = permuteBars(candles, 0)
    const fn = hypothesis.makeSignal(permuted)
    const trades = runEngine(permuted, fn).trades
    const stats = summarize(trades)
    permMetrics.push(stats.expectancyR)
    if (stats.expectancyR >= realMetric) asGoodOrBetter++
  }

  permMetrics.sort((a, b) => a - b)
  const pValue = asGoodOrBetter / numPermutations
  const median = permMetrics[Math.floor(permMetrics.length / 2)]
  const p25 = permMetrics[Math.floor(permMetrics.length * 0.25)]
  const p75 = permMetrics[Math.floor(permMetrics.length * 0.75)]

  return {
    realMetric, realStats, pValue, numPermutations,
    permMin: permMetrics[0], permP25: p25, permMedian: median,
    permP75: p75, permMax: permMetrics[permMetrics.length - 1],
  }
}

function runContextExplorer(candles) {
  const sma20 = calcSMASeries(candles, 20)
  const events = detectSweepEvents(candles)
  const withOutcomes = []
  for (const ev of events) {
    const outcome = simulateEventOutcome(candles, ev.idx, ev.direction)
    if (!outcome) continue
    const features = contextualFeatures(candles, sma20, ev.idx, ev.direction)
    withOutcomes.push({ ...features, outcome })
  }
  return {
    totalEvents: events.length,
    resolvedEvents: withOutcomes.length,
    byRecentRange: quantileBuckets(withOutcomes, 'recentRange'),
    byWickSize: quantileBuckets(withOutcomes, 'wickSize'),
    byTrendSteepness: quantileBuckets(withOutcomes, 'trendSteepness'),
    joint: jointBuckets(withOutcomes),
  }
}

// ── Generic PIP-clustering pattern miner ────────────────────────────
// Different in kind from every hypothesis above. Nothing here starts from
// a human-named feature (wick size, trend steepness, gap magnitude) \u2014 it
// extracts the geometric SHAPE of every price window, groups similar
// shapes via k-means (cluster count chosen automatically via silhouette
// score, not guessed), and only afterward checks whether any shape-cluster
// predicts anything. Deliberately generic on the input series \u2014
// findPIPs/extractPatterns take any numeric array, not candles
// specifically, so the exact same engine can run on volume, an
// intermarket spread, or any other series once that data exists, with
// zero new code.
//
// The permutation-tested validation step is the load-bearing part: picking
// the single best-looking cluster out of several is about as aggressive a
// multiple-comparisons search as exists \u2014 on pure noise, SOMETHING will
// always look like the best cluster. This reuses the already-verified
// permuteBars() to re-run the ENTIRE mining pipeline (not just re-test one
// fixed rule) on scrambled data repeatedly, and compares the real best
// cluster against what that same greedy search finds on fake data.

function findPIPs(series, nPips) {
  const n = series.length
  if (n < 2) return []
  let pipIndices = [0, n - 1]
  while (pipIndices.length < nPips) {
    let maxDist = -1, maxDistIdx = -1, insertPos = -1
    for (let k = 0; k < pipIndices.length - 1; k++) {
      const leftIdx = pipIndices[k], rightIdx = pipIndices[k + 1]
      if (rightIdx - leftIdx < 2) continue
      const x1 = leftIdx, y1 = series[leftIdx]
      const x2 = rightIdx, y2 = series[rightIdx]
      const dx = x2 - x1, dy = y2 - y1
      const norm = Math.sqrt(dx * dx + dy * dy)
      for (let idx = leftIdx + 1; idx < rightIdx; idx++) {
        const x0 = idx, y0 = series[idx]
        const dist = norm > 0 ? Math.abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm : Math.abs(y0 - y1)
        if (dist > maxDist) { maxDist = dist; maxDistIdx = idx; insertPos = k + 1 }
      }
    }
    if (maxDistIdx === -1) break
    pipIndices.splice(insertPos, 0, maxDistIdx)
  }
  return pipIndices.sort((a, b) => a - b)
}

function extractPatterns(series, lookback, nPips, minGap) {
  const patterns = []
  let lastAcceptedEnd = -Infinity
  for (let end = lookback; end < series.length; end++) {
    if (end - lastAcceptedEnd < minGap) continue
    const window = series.slice(end - lookback, end + 1)
    const pipIdx = findPIPs(window, nPips)
    if (pipIdx.length < nPips) continue
    const pipVals = pipIdx.map((i) => window[i])
    const mean = pipVals.reduce((a, b) => a + b, 0) / pipVals.length
    const variance = pipVals.reduce((a, b) => a + (b - mean) ** 2, 0) / pipVals.length
    const std = Math.sqrt(variance)
    if (std === 0) continue
    patterns.push({ endIdx: end, pattern: pipVals.map((v) => (v - mean) / std) })
    lastAcceptedEnd = end
  }
  return patterns
}

function euclideanDist(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
  return Math.sqrt(s)
}

function kmeansPlusPlusInit(vectors, k) {
  const centroids = [vectors[Math.floor(Math.random() * vectors.length)]]
  while (centroids.length < k) {
    const dists = vectors.map((v) => Math.min(...centroids.map((c) => euclideanDist(v, c) ** 2)))
    const total = dists.reduce((a, b) => a + b, 0)
    let r = Math.random() * total, idx = 0
    for (; idx < dists.length; idx++) { r -= dists[idx]; if (r <= 0) break }
    centroids.push(vectors[Math.min(idx, vectors.length - 1)])
  }
  return centroids
}

function kmeansCluster(vectors, k, maxIter = 50) {
  let centroids = kmeansPlusPlusInit(vectors, k)
  let assignments = new Array(vectors.length).fill(0)
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false
    for (let i = 0; i < vectors.length; i++) {
      let bestDist = Infinity, bestC = 0
      for (let c = 0; c < k; c++) {
        const d = euclideanDist(vectors[i], centroids[c])
        if (d < bestDist) { bestDist = d; bestC = c }
      }
      if (assignments[i] !== bestC) changed = true
      assignments[i] = bestC
    }
    const counts = new Array(k).fill(0)
    const sums = Array.from({ length: k }, () => new Array(vectors[0].length).fill(0))
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i]
      counts[c]++
      for (let d = 0; d < vectors[i].length; d++) sums[c][d] += vectors[i][d]
    }
    centroids = Array.from({ length: k }, (_, c) => (counts[c] === 0 ? centroids[c] : sums[c].map((s) => s / counts[c])))
    if (!changed) break
  }
  return { assignments, centroids }
}

function silhouetteScore(vectors, assignments, k, sampleCap = 800) {
  let sample = vectors.map((v, i) => ({ v, i, a: assignments[i] }))
  if (sample.length > sampleCap) {
    const sh = [...sample]
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[sh[i], sh[j]] = [sh[j], sh[i]] }
    sample = sh.slice(0, sampleCap)
  }
  const n = sample.length
  if (k < 2 || k >= n) return -1
  let total = 0, counted = 0
  for (let i = 0; i < n; i++) {
    const ci = sample[i].a
    let aSum = 0, aCount = 0
    const bSums = new Array(k).fill(0), bCounts = new Array(k).fill(0)
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const d = euclideanDist(sample[i].v, sample[j].v)
      if (sample[j].a === ci) { aSum += d; aCount++ } else { bSums[sample[j].a] += d; bCounts[sample[j].a]++ }
    }
    if (aCount === 0) continue
    const a = aSum / aCount
    let b = Infinity
    for (let c = 0; c < k; c++) { if (c === ci || bCounts[c] === 0) continue; b = Math.min(b, bSums[c] / bCounts[c]) }
    if (!Number.isFinite(b)) continue
    total += (b - a) / Math.max(a, b)
    counted++
  }
  return counted > 0 ? total / counted : -1
}

function findBestK(vectors, kMin, kMax) {
  let best = { k: kMin, score: -Infinity, assignments: null, centroids: null }
  for (let k = kMin; k <= kMax; k++) {
    const { assignments, centroids } = kmeansCluster(vectors, k)
    const score = silhouetteScore(vectors, assignments, k)
    if (score > best.score) best = { k, score, assignments, centroids }
  }
  return best
}

function evaluateCluster(outcomes) {
  const n = outcomes.length
  if (n === 0) return null
  const rMults = outcomes.map((o) => o.rMult)
  const mean = rMults.reduce((a, b) => a + b, 0) / n
  const variance = n > 1 ? rMults.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0
  const se = Math.sqrt(variance / n)
  const ci95 = 1.96 * se
  const totalDollar = outcomes.reduce((a, b) => a + b.dollarPnl, 0)
  const wins = outcomes.filter((o) => o.dollarPnl > 0).length
  const wilson = wilsonInterval(wins, n)
  return {
    n, expectancyR: +mean.toFixed(3), ci95: +ci95.toFixed(3),
    lower: +(mean - ci95).toFixed(3), upper: +(mean + ci95).toFixed(3),
    totalDollar: +totalDollar.toFixed(0),
    winRate: +((wins / n) * 100).toFixed(1),
    winRateLower: +(wilson.lower * 100).toFixed(1),
    winRateUpper: +(wilson.upper * 100).toFixed(1),
  }
}

// Redesigned around what pattern mining is actually for: FINDING shapes
// that recur, not immediately testing whether they're profitable. Uses a
// FIXED, higher cluster count (kFixed) rather than silhouette-selected k
// \u2014 silhouette scoring is biased toward FEWER, broadly-separated groups
// (tested directly: widening the search range to k=30 still only chose
// k=5), which produces large, generic buckets, not specific recognizable
// shapes. A fixed higher k forces smaller, more specific groups. Clusters
// are sorted by COHESION (how tightly members actually match their own
// centroid \u2014 lower is a more consistently-repeating shape), not by
// trading outcome. Trading stats (direction, expectancy, win rate) are
// still computed and shown per shape, as supplementary information, but
// they no longer gate which shapes you get to see \u2014 a tight, clearly
// recurring shape with too little forward-return data to trust a trading
// estimate is still shown as a real discovered pattern; it just doesn't
// get a trading verdict attached.
function minePricePatterns(candles, opts = {}) {
  const lookback = opts.lookback ?? 24
  const nPips = opts.nPips ?? 5
  const minGap = opts.minGap ?? 12
  const kFixed = opts.kFixed ?? 16
  const forwardHorizon = opts.forwardHorizon ?? 10
  const minShapeMembers = opts.minShapeMembers ?? 15

  const closes = candles.map((c) => c.close)
  const patterns = extractPatterns(closes, lookback, nPips, minGap)
  if (patterns.length < kFixed * 10) return { error: 'Too few patterns extracted \u2014 need more months of data or a shorter lookback.' }

  const vectors = patterns.map((p) => p.pattern)
  const { assignments, centroids } = kmeansCluster(vectors, kFixed)

  const clusters = []
  for (let c = 0; c < kFixed; c++) {
    const memberIdx = []
    for (let i = 0; i < assignments.length; i++) if (assignments[i] === c) memberIdx.push(i)
    if (memberIdx.length < minShapeMembers) continue

    const cohesionVal = memberIdx.reduce((sum, i) => sum + euclideanDist(vectors[i], centroids[c]), 0) / memberIdx.length

    let direction = null, evalResult = null
    const fwdReturns = []
    for (const i of memberIdx) {
      const endIdx = patterns[i].endIdx
      if (endIdx + forwardHorizon >= candles.length) continue
      fwdReturns.push(candles[endIdx + forwardHorizon].close - candles[endIdx].close)
    }
    if (fwdReturns.length >= 10) {
      const avgFwd = fwdReturns.reduce((a, b) => a + b, 0) / fwdReturns.length
      direction = avgFwd >= 0 ? 'bullish' : 'bearish'
      const outcomes = []
      for (const i of memberIdx) {
        const outcome = simulateEventOutcome(candles, patterns[i].endIdx, direction)
        if (outcome) outcomes.push(outcome)
      }
      evalResult = evaluateCluster(outcomes)
    }

    const exampleCount = Math.min(4, memberIdx.length)
    const step = Math.max(1, Math.floor(memberIdx.length / exampleCount))
    const examples = []
    for (let e = 0; e < exampleCount; e++) {
      const i = memberIdx[Math.min(e * step, memberIdx.length - 1)]
      const endIdx = patterns[i].endIdx
      examples.push({ endIdx, rawWindow: closes.slice(Math.max(0, endIdx - lookback), endIdx + 1) })
    }

    clusters.push({
      clusterId: c, patternCount: memberIdx.length, cohesion: +cohesionVal.toFixed(3),
      centroidPattern: centroids[c], examples, direction, ...(evalResult || {}),
    })
  }

  clusters.sort((a, b) => a.cohesion - b.cohesion) // tightest, most consistently-repeating shape first
  const withTradingEval = clusters.filter((c) => c.expectancyR != null)
  const bestByExpectancy = [...withTradingEval].sort((a, b) => b.expectancyR - a.expectancyR)[0] || null

  return { totalPatterns: patterns.length, k: kFixed, clusters, bestByExpectancy }
}

function runMiningPermutationTest(candles, opts = {}, numPermutations = 20) {
  const real = minePricePatterns(candles, opts)
  if (real.error || !real.bestByExpectancy) return { ...real, permutationSkipped: true }

  const realBestR = real.bestByExpectancy.expectancyR
  let asGoodOrBetter = 0
  const permBests = []
  for (let p = 0; p < numPermutations; p++) {
    const permuted = permuteBars(candles, 0)
    const result = minePricePatterns(permuted, opts)
    const bestR = (result.bestByExpectancy && result.bestByExpectancy.expectancyR) ?? -Infinity
    permBests.push(bestR)
    if (bestR >= realBestR) asGoodOrBetter++
  }
  permBests.sort((a, b) => a - b)
  return {
    ...real,
    pValue: asGoodOrBetter / numPermutations,
    numPermutations,
    permMin: permBests[0],
    permMedian: permBests[Math.floor(permBests.length / 2)],
    permMax: permBests[permBests.length - 1],
  }
}

// ── Combination grid: entry \u00d7 sizing \u00d7 session \u00d7 contextual gate ──
// Runs base (ungated) entry rules through every combination of sizing mode,
// session window, and contextual gate (the quantified "human features"
// from the Context Explorer \u2014 trend alignment, ATR floor, small wick),
// generated systematically rather than hand-picked. Deliberately uses the
// BASE hypotheses (H1, H2, H3a, H5, H6, H7), not the already hand-gated
// variants (H2c, H8b, etc.) \u2014 combining an already-gated rule with more
// grid gates would double-apply and confuse the result.
//
// Picking the single best of many combinations is an aggressive
// multiple-comparisons search \u2014 the whole 240-combination grid, not just
// the winner, gets re-run on permuted data to check whether the real best
// result is actually distinguishable from what this same greedy process
// finds on noise. This runs automatically as one step, not a separate
// button, since re-validating by hand every time defeats the purpose.

function wrapWithGates(baseHyp, sessionName, contextualGate) {
  return {
    makeSignal: (candles) => {
      const baseFn = baseHyp.makeSignal(candles)
      const sma20 = contextualGate === 'trend' ? calcSMASeries(candles, 20) : null
      return (i) => {
        const action = baseFn(i)
        if (action !== 'buy' && action !== 'sell') return action
        if (sessionName !== 'none' && getSession(candles[i].time) !== sessionName) return 'none'
        if (contextualGate === 'trend') {
          let ts = 0
          if (i >= 5 && sma20[i] != null && sma20[i - 5] != null && sma20[i - 5] !== 0) ts = (sma20[i] - sma20[i - 5]) / sma20[i - 5]
          if (action === 'buy' && ts <= 0) return 'none'
          if (action === 'sell' && ts >= 0) return 'none'
        } else if (contextualGate === 'atrFloor') {
          if (calcATR(candles, i) <= 33.33) return 'none'
        } else if (contextualGate === 'smallWick') {
          const c = candles[i]
          const range = c.high - c.low
          if (range <= 0) return 'none'
          const wick = action === 'buy' ? (Math.min(c.open, c.close) - c.low) : (c.high - Math.max(c.open, c.close))
          if (wick / range > 0.25) return 'none'
        }
        return action
      }
    },
  }
}

const GRID_ENTRY_IDS = ['h1_orb', 'h2_pdh_pdl_sweep', 'h3a_momentum_any', 'h5_ema_pullback', 'h6_vwap_reversion', 'h7_amd_asian_london']
const GRID_SIZING = ['riskAdjusted', 'fixed6']
const GRID_SESSION = ['New York', 'Offhours', 'London', 'Asian', 'none']
const GRID_CONTEXTUAL = ['trend', 'atrFloor', 'smallWick', 'none']

function runFullGrid(candles) {
  const results = []
  for (const entryId of GRID_ENTRY_IDS) {
    const baseHyp = HYPOTHESES.find((h) => h.id === entryId)
    if (!baseHyp) continue
    for (const sizing of GRID_SIZING) {
      for (const session of GRID_SESSION) {
        for (const contextual of GRID_CONTEXTUAL) {
          const wrapped = wrapWithGates(baseHyp, session, contextual)
          const fn = wrapped.makeSignal(candles)
          const opts = sizing === 'fixed6' ? { fixedContracts: 6 } : {}
          const { trades } = runEngine(candles, fn, opts)
          if (trades.length < 10) continue
          const stats = summarize(trades)
          results.push({ entryId, sizing, session, contextual, ...stats })
        }
      }
    }
  }
  results.sort((a, b) => b.expectancyR - a.expectancyR)
  return results
}

function runGridPermutationTest(candles, numPermutations = 20) {
  const realResults = runFullGrid(candles)
  const realBest = realResults[0] || null
  if (!realBest) return { results: realResults, best: null, permutationSkipped: true }

  let asGoodOrBetter = 0
  const permBests = []
  for (let p = 0; p < numPermutations; p++) {
    const permuted = permuteBars(candles, 0)
    const permResults = runFullGrid(permuted)
    const bestR = (permResults[0] && permResults[0].expectancyR) ?? -Infinity
    permBests.push(bestR)
    if (bestR >= realBest.expectancyR) asGoodOrBetter++
  }
  permBests.sort((a, b) => a - b)
  return {
    results: realResults,
    best: realBest,
    pValue: asGoodOrBetter / numPermutations,
    numPermutations,
    permMin: permBests[0],
    permMedian: permBests[Math.floor(permBests.length / 2)],
    permMax: permBests[permBests.length - 1],
  }
}

// ── Intermarket Pattern Miner (NQ vs. ES) ─────────────────────────
// The generic mining engine (findPIPs/extractPatterns/kmeansCluster),
// completely unchanged, pointed at a genuinely new series instead of
// NQ's own price \u2014 the log-ratio spread between NQ and ES, i.e. whether
// NQ is outperforming or underperforming ES at each point. This is a
// relationship between two instruments, not a shape in one instrument's
// own price \u2014 something the two prior mining runs on NQ price alone
// (p=40%, p=85%) structurally could not have found, however thoroughly
// they searched.
//
// PLACEHOLDER: 'ES' below is a guess at Massive's exact ticker string.
// Check the [TICKER CHECK] console log (added to the Train fetch) against
// your actual Massive dashboard/FUTURES_SYMBOLS list and correct this if
// the real ticker differs (e.g. 'ES1!', 'ESZ25', etc.).
const INTERMARKET_SYMBOL = 'ES'

function alignByTimestamp(candlesA, candlesB) {
  const mapB = new Map(candlesB.map((c) => [c.time, c]))
  const alignedA = [], alignedB = []
  for (const c of candlesA) {
    const match = mapB.get(c.time)
    if (match) { alignedA.push(c); alignedB.push(match) }
  }
  return { alignedA, alignedB }
}

function computeLogRatioSpread(closesA, closesB) {
  return closesA.map((a, i) => Math.log(a) - Math.log(closesB[i]))
}

// Reuses minePricePatterns' exact cluster-evaluation and example-capture
// logic, just swapping in the spread series for the shape search while
// keeping NQ's own candles (aligned) for outcome evaluation \u2014 the thing
// being mined is the relationship, the thing being traded and measured is
// still NQ, through the same ATR stop/target and friction model as
// everywhere else in this Lab.
function mineIntermarketPatterns(nqCandles, esCandles, opts = {}) {
  const lookback = opts.lookback ?? 24
  const nPips = opts.nPips ?? 5
  const minGap = opts.minGap ?? 12
  const kFixed = opts.kFixed ?? 16
  const forwardHorizon = opts.forwardHorizon ?? 10
  const minShapeMembers = opts.minShapeMembers ?? 15

  const { alignedA: nq, alignedB: es } = alignByTimestamp(nqCandles, esCandles)
  if (nq.length < 500) return { error: 'Too few aligned NQ/ES bars \u2014 check the ticker symbol and month overlap.' }

  const spread = computeLogRatioSpread(nq.map((c) => c.close), es.map((c) => c.close))
  const patterns = extractPatterns(spread, lookback, nPips, minGap)
  if (patterns.length < kFixed * 10) return { error: 'Too few spread patterns extracted \u2014 need more months of data or a shorter lookback.' }

  const vectors = patterns.map((p) => p.pattern)
  const { assignments, centroids } = kmeansCluster(vectors, kFixed)

  const clusters = []
  for (let c = 0; c < kFixed; c++) {
    const memberIdx = []
    for (let i = 0; i < assignments.length; i++) if (assignments[i] === c) memberIdx.push(i)
    if (memberIdx.length < minShapeMembers) continue

    const cohesionVal = memberIdx.reduce((sum, i) => sum + euclideanDist(vectors[i], centroids[c]), 0) / memberIdx.length

    let direction = null, evalResult = null
    const fwdReturns = []
    for (const i of memberIdx) {
      const endIdx = patterns[i].endIdx
      if (endIdx + forwardHorizon >= nq.length) continue
      fwdReturns.push(nq[endIdx + forwardHorizon].close - nq[endIdx].close)
    }
    if (fwdReturns.length >= 10) {
      const avgFwd = fwdReturns.reduce((a, b) => a + b, 0) / fwdReturns.length
      direction = avgFwd >= 0 ? 'bullish' : 'bearish'
      const outcomes = []
      for (const i of memberIdx) {
        const outcome = simulateEventOutcome(nq, patterns[i].endIdx, direction)
        if (outcome) outcomes.push(outcome)
      }
      evalResult = evaluateCluster(outcomes)
    }

    const exampleCount = Math.min(4, memberIdx.length)
    const step = Math.max(1, Math.floor(memberIdx.length / exampleCount))
    const examples = []
    for (let e = 0; e < exampleCount; e++) {
      const i = memberIdx[Math.min(e * step, memberIdx.length - 1)]
      const endIdx = patterns[i].endIdx
      examples.push({ endIdx, rawWindow: spread.slice(Math.max(0, endIdx - lookback), endIdx + 1) })
    }

    clusters.push({
      clusterId: c, patternCount: memberIdx.length, cohesion: +cohesionVal.toFixed(3),
      centroidPattern: centroids[c], examples, direction, ...(evalResult || {}),
    })
  }

  clusters.sort((a, b) => a.cohesion - b.cohesion)
  return { totalPatterns: patterns.length, alignedBars: nq.length, k: kFixed, clusters }
}

// ── SMC Liquidity Sweep + FVG Continuation (Dynamic Profit Hold) ────
// Ported faithfully from a strategy built in a separate tool, using
// primitives built from scratch here \u2014 the original app's indicator
// source code isn't available, so these are independent implementations,
// each individually tested against known cases (delayed-confirmation
// swings, look-ahead-safe FVG/CISD/rejection-block) before assembly.
//
// Structurally different from every other hypothesis in this Lab: state
// (adaptive stop-loss level, win/loss streaks, sweep-entry deferral)
// persists ACROSS trades, and stops are percentage-based, not ATR-based.
// This needs its own dedicated simulation \u2014 the shared runEngine was
// never built for this trade structure.
//
// Worth flagging honestly: this strategy's rules were shaped through
// several rounds of watching backtest results and patching specific
// observed problems (visible in its own iteration notes) \u2014 a real
// overfitting risk baked into the rule set itself, independent of
// whether these specific indicator implementations are correct. Testing
// it properly here, especially on data from after the rules were last
// changed, is how that concern actually gets resolved rather than
// assumed either way.

const SMC_ACCOUNT_SIZE = 25000, SMC_RISK_PCT = 1, SMC_POINT_VALUE = 5 // MES

function smcDetectSwingLows(candles, lookback = 5) {
  const out = new Array(candles.length).fill(false)
  for (let i = lookback; i < candles.length - lookback; i++) {
    let ok = true
    for (let k = 1; k <= lookback; k++) { if (candles[i-k].low <= candles[i].low || candles[i+k].low <= candles[i].low) { ok = false; break } }
    if (ok) out[i] = true
  }
  return out
}
function smcDetectSwingHighs(candles, lookback = 5) {
  const out = new Array(candles.length).fill(false)
  for (let i = lookback; i < candles.length - lookback; i++) {
    let ok = true
    for (let k = 1; k <= lookback; k++) { if (candles[i-k].high >= candles[i].high || candles[i+k].high >= candles[i].high) { ok = false; break } }
    if (ok) out[i] = true
  }
  return out
}
function smcDetectBullishBOS(candles, lookback = 5) {
  const sh = smcDetectSwingHighs(candles, lookback)
  const out = new Array(candles.length).fill(false)
  let last = null
  for (let i = 0; i < candles.length; i++) {
    const k = i - lookback
    if (k >= 0 && sh[k]) last = candles[k].high
    if (last != null && candles[i].close > last) out[i] = true
  }
  return out
}
function smcDetectBearishBOS(candles, lookback = 5) {
  const sl = smcDetectSwingLows(candles, lookback)
  const out = new Array(candles.length).fill(false)
  let last = null
  for (let i = 0; i < candles.length; i++) {
    const k = i - lookback
    if (k >= 0 && sl[k]) last = candles[k].low
    if (last != null && candles[i].close < last) out[i] = true
  }
  return out
}
function smcDetectSweepOfSwingLow(candles, lookback = 5) {
  const sl = smcDetectSwingLows(candles, lookback)
  const out = new Array(candles.length).fill(false)
  let last = null
  for (let i = 0; i < candles.length; i++) {
    const k = i - lookback
    if (k >= 0 && sl[k]) last = candles[k].low
    if (last != null && candles[i].low < last && candles[i].close > last) out[i] = true
  }
  return out
}
function smcDetectBullishFVG(candles) {
  const zones = []
  const touched = new Array(candles.length).fill(false)
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i-2], c = candles[i]
    if (a.high < c.low) zones.push({ createdAt: i, zoneLow: a.high, zoneHigh: c.low, filled: false })
  }
  for (let i = 0; i < candles.length; i++) {
    for (const z of zones) {
      if (z.createdAt >= i || z.filled) continue
      if (candles[i].low <= z.zoneHigh && candles[i].low >= z.zoneLow) { touched[i] = true; z.filled = true }
    }
  }
  return touched
}
function smcDetectBullishCISD(candles) {
  const out = new Array(candles.length).fill(false)
  for (let i = 1; i < candles.length; i++) {
    const bullNow = candles[i].close > candles[i].open
    const bearPrev = candles[i-1].close < candles[i-1].open
    if (bullNow && bearPrev && candles[i].close > candles[i-1].high) out[i] = true
  }
  return out
}
function smcDetectBearishCISD(candles) {
  const out = new Array(candles.length).fill(false)
  for (let i = 1; i < candles.length; i++) {
    const bearNow = candles[i].close < candles[i].open
    const bullPrev = candles[i-1].close > candles[i-1].open
    if (bearNow && bullPrev && candles[i].close < candles[i-1].low) out[i] = true
  }
  return out
}
function smcDetectBullishRejectionBlock(candles, thresh = 0.5) {
  const out = new Array(candles.length).fill(false)
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], range = c.high - c.low
    if (range <= 0) continue
    const lowerWick = Math.min(c.open, c.close) - c.low
    if (lowerWick / range >= thresh) out[i] = true
  }
  return out
}

function smcSizeAndCostTrade(entryPrice, exitPrice, stopPctUsed) {
  const riskDollars = SMC_ACCOUNT_SIZE * (SMC_RISK_PCT / 100)
  const stopDistPoints = entryPrice * (stopPctUsed / 100)
  const contracts = Math.max(1, Math.floor(riskDollars / (stopDistPoints * SMC_POINT_VALUE)))
  const slippedEntry = entryPrice + TICK_SIZE * 1
  const slippedExit  = exitPrice - TICK_SIZE * 1
  const grossPnl = (slippedExit - slippedEntry) * SMC_POINT_VALUE * contracts
  const commission = COMMISSION_PER_SIDE * 2 * contracts
  return { contracts, dollarPnl: grossPnl - commission, riskDollars }
}

function simulateSMCStrategy(candles) {
  const ind = {
    liquiditySweepLow: smcDetectSweepOfSwingLow(candles),
    bullishFVG: smcDetectBullishFVG(candles),
    bosBullish: smcDetectBullishBOS(candles),
    bosBearish: smcDetectBearishBOS(candles),
    cisdBullish: smcDetectBullishCISD(candles),
    cisdBearish: smcDetectBearishCISD(candles),
    rejectionBlockBullish: smcDetectBullishRejectionBlock(candles),
    swingHigh: smcDetectSwingHighs(candles),
  }
  let state = { _sl: 1.8, _consLoss: 0, _consWin: 0, _sweepEntry: false, _deferred: false }
  let pos = null
  const trades = []

  for (let i = 20; i < candles.length; i++) {
    const sweep = ind.liquiditySweepLow[i] || ind.liquiditySweepLow[i-1] || ind.liquiditySweepLow[i-2]
    const fvg = ind.bullishFVG[i] || ind.bullishFVG[i-1] || ind.bullishFVG[i-2]
    const bos = ind.bosBullish[i] || ind.bosBullish[i-1] || ind.bosBullish[i-2]
    const cisd = ind.cisdBullish[i] || ind.cisdBullish[i-1]
    const rejBlock = ind.rejectionBlockBullish[i] || ind.rejectionBlockBullish[i-1]
    const bearBos = ind.bosBearish[i] || ind.bosBearish[i-1]
    const bearCisd = ind.cisdBearish[i] || ind.cisdBearish[i-1]
    const recentBearBos = ind.bosBearish[i] || ind.bosBearish[i-1] || ind.bosBearish[i-2]

    const ep = pos?.entryPrice || 0
    const cc = candles[i]?.close || 0
    const gainPct = ep > 0 ? ((cc - ep) / ep) * 100 : 0
    const intradayHigh = Math.max(...candles.slice(Math.max(0, i - 26), i + 1).map((c) => c.high))
    const breakHigh = cc >= intradayHigh
    const contPat = bos && ind.swingHigh[i]
    const holdOverride = breakHigh || contPat
    const hardCap = state._sweepEntry ? 5.0 : 3.0
    const inSweepDip = state._sweepEntry && sweep
    const stopHitAdaptive = gainPct <= -state._sl
    const stopHitHard = gainPct <= -hardCap
    const inZone = gainPct >= 1.0 && gainPct <= 2.0
    const lookbackHigh = Math.max(...candles.slice(Math.max(0, i - 10), i + 1).map((c) => c.high))
    const sharpDrop = cc > 0 && lookbackHigh > 0 && ((lookbackHigh - cc) / lookbackHigh) * 100 >= 1.5

    if (!pos && !recentBearBos && !bearCisd) {
      const primaryBase = sweep && fvg && bos
      const primaryScore = (sweep?1:0)+(fvg?1:0)+(bos?1:0)+(cisd?1:0)+(rejBlock?1:0)
      const dipScore = (fvg?1:0)+(cisd?1:0)+(rejBlock?1:0)+(bos?1:0)+(sweep?1:0)
      if (primaryBase && primaryScore >= 3) {
        pos = { entryPrice: cc, entryIdx: i, entryType: 'primary', stopPctAtEntry: state._sl }
        state._sweepEntry = true; state._deferred = false
        continue
      }
      if (!primaryBase && sharpDrop && fvg && dipScore >= 4) {
        pos = { entryPrice: cc, entryIdx: i, entryType: 'dip', stopPctAtEntry: state._sl }
        state._sweepEntry = false; state._deferred = false
        continue
      }
    }

    if (pos) {
      if (stopHitAdaptive && state._sweepEntry && inSweepDip && !stopHitHard) { state._deferred = true; continue }
      if (state._deferred && state._sweepEntry && gainPct >= -1.0 && !stopHitHard) continue

      let exitReason = null
      if (stopHitHard || (stopHitAdaptive && !state._deferred)) {
        exitReason = stopHitHard ? 'hardCap' : 'adaptiveSL'
        const newLoss = state._consLoss + 1
        state._sl = newLoss >= 3 ? Math.max(0.8, +(state._sl - 0.1).toFixed(1)) : state._sl
        state._consLoss = newLoss >= 3 ? 0 : newLoss
        state._consWin = 0
      } else if (inZone && !holdOverride) {
        exitReason = 'profitZone'
        const newWin = state._consWin + 1
        state._sl = newWin >= 3 ? Math.min(1.8, +(state._sl + 0.1).toFixed(1)) : state._sl
        state._consWin = newWin >= 3 ? 0 : newWin
        state._consLoss = 0
      } else if (gainPct > 2.0 && !holdOverride && bearBos) {
        exitReason = 'extendedExit'
      } else if (bearBos && !holdOverride) {
        exitReason = 'biasInvalidation'
      }

      if (exitReason) {
        const { contracts, dollarPnl } = smcSizeAndCostTrade(pos.entryPrice, cc, pos.stopPctAtEntry)
        trades.push({ ...pos, exitIdx: i, exitPrice: cc, gainPct, reason: exitReason, contracts, dollarPnl })
        pos = null; state._sweepEntry = false; state._deferred = false
      }
    }
  }
  return trades
}

// ── H9 Neighborhood Grid ──────────────────────────────────────────
// A small, fixed, pre-declared grid anchored specifically around H9's own
// structure (ATR threshold, session scope, entry direction) \u2014 not a
// search across unrelated hypotheses. Answers the actual question at
// stake: does H9 sit inside a broad region of positive expectancy, or
// right at a single lucky point that collapses the moment any dimension
// shifts. The whole 42-combination neighborhood, not just the winner,
// gets re-run on permuted data \u2014 exploring "combinations around H9" is
// still search, and still needs the same validation discipline as
// Section 7's larger grid.

const H9_ATR_VALUES = [20, 25, 30, 33.33, 40, 50, 60]
const H9_SESSION_SCOPES = ['Asian-full', 'Asian-core']
const H9_DIRECTIONS = ['both', 'long-only', 'short-only']

function makeH9VariantSignal(candles, opts) {
  const { atrThreshold, sessionScope, direction } = opts
  let curDay = null, curHigh = null, curLow = null, pdh = null, pdl = null
  return (i) => {
    const c = candles[i]
    const d = dayKey(c.time)
    if (d !== curDay) {
      if (curDay !== null) { pdh = curHigh; pdl = curLow }
      curDay = d; curHigh = c.high; curLow = c.low
    } else {
      curHigh = Math.max(curHigh, c.high)
      curLow  = Math.min(curLow, c.low)
    }
    if (pdh == null || pdl == null) return 'none'

    const h = utcHour(c.time)
    const inSession = sessionScope === 'Asian-full' ? getSession(c.time) === 'Asian' : (h === 0 || h === 1 || h === 2)
    if (!inSession) return 'none'
    if (calcATR(candles, i) <= atrThreshold) return 'none'

    if (c.low  < pdl && c.close > pdl) { if (direction === 'short-only') return 'none'; return 'buy' }
    if (c.high > pdh && c.close < pdh) { if (direction === 'long-only') return 'none'; return 'sell' }
    return 'none'
  }
}

function runH9NeighborhoodGrid(candles) {
  const results = []
  for (const atrThreshold of H9_ATR_VALUES) {
    for (const sessionScope of H9_SESSION_SCOPES) {
      for (const direction of H9_DIRECTIONS) {
        const fn = makeH9VariantSignal(candles, { atrThreshold, sessionScope, direction })
        const { trades } = runEngine(candles, fn)
        if (trades.length < 5) continue
        const stats = summarize(trades)
        results.push({ atrThreshold, sessionScope, direction, ...stats })
      }
    }
  }
  results.sort((a, b) => b.expectancyR - a.expectancyR)
  return results
}

function runH9GridPermutationTest(candles, numPermutations = 100) {
  const realResults = runH9NeighborhoodGrid(candles)
  const realBest = realResults[0] || null
  if (!realBest) return { results: realResults, best: null, permutationSkipped: true }

  let asGoodOrBetter = 0
  const permBests = []
  for (let p = 0; p < numPermutations; p++) {
    const permuted = permuteBars(candles, 0)
    const permResults = runH9NeighborhoodGrid(permuted)
    const bestR = (permResults[0] && permResults[0].expectancyR) ?? -Infinity
    permBests.push(bestR)
    if (bestR >= realBest.expectancyR) asGoodOrBetter++
  }
  permBests.sort((a, b) => a - b)
  return {
    results: realResults,
    best: realBest,
    pValue: asGoodOrBetter / numPermutations,
    numPermutations,
    permMin: permBests[0],
    permMedian: permBests[Math.floor(permBests.length / 2)],
    permMax: permBests[permBests.length - 1],
  }
}

// ── Gap magnitude on Opening Range Breakout ───────────────────────
// A second, separate contextual-feature study \u2014 not another cut of the
// PDH/PDL sweep event, a different event entirely (same one H1 already
// uses). One of the few genuinely clean, monotonic findings from outside
// research: |today's open \u2212 yesterday's close| normalized by ATR,
// tested against ORB outcome. The reported result on ES was a clean
// climb in win rate across quintiles (42%\u219244%\u219250%\u219252%\u219251%),
// p=0.000012 \u2014 worth checking whether the same pattern shows up here.

function detectORBEvents(candles) {
  const events = []
  let day = null, rangeHigh = -Infinity, rangeLow = Infinity, fired = false
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const d = dayKey(c.time)
    if (d !== day) { day = d; rangeHigh = -Infinity; rangeLow = Infinity; fired = false }
    const h = utcHour(c.time), m = utcMinute(c.time)
    if (h === 13 && m < 30) {
      rangeHigh = Math.max(rangeHigh, c.high)
      rangeLow  = Math.min(rangeLow, c.low)
      continue
    }
    if (fired || rangeHigh === -Infinity) continue
    if (c.close > rangeHigh) { events.push({ idx: i, direction: 'bullish' }); fired = true }
    else if (c.close < rangeLow) { events.push({ idx: i, direction: 'bearish' }); fired = true }
  }
  return events
}

function gapMagnitudeFeature(candles, eventIdx) {
  const eventDay = dayKey(candles[eventIdx].time)
  let todayOpenIdx = eventIdx
  while (todayOpenIdx > 0 && dayKey(candles[todayOpenIdx - 1].time) === eventDay) todayOpenIdx--
  if (todayOpenIdx === 0) return null
  const todayOpen = candles[todayOpenIdx].open
  const yesterdayClose = candles[todayOpenIdx - 1].close
  const atr = calcATR(candles, eventIdx)
  if (atr <= 0) return null
  return Math.abs(todayOpen - yesterdayClose) / atr
}

function runGapAnalysis(candles) {
  const events = detectORBEvents(candles)
  const withOutcomes = []
  for (const ev of events) {
    const outcome = simulateEventOutcome(candles, ev.idx, ev.direction)
    if (!outcome) continue
    const gapMagnitude = gapMagnitudeFeature(candles, ev.idx)
    if (gapMagnitude == null) continue
    withOutcomes.push({ gapMagnitude, outcome })
  }
  return {
    totalEvents: events.length,
    resolvedEvents: withOutcomes.length,
    byGapMagnitude: quantileBuckets(withOutcomes, 'gapMagnitude'),
  }
}

// ── Minimal engine — fresh, not shared with backtest.js ─────────────
// Every fill below goes through slip() and every closed trade pays
// commission on both sides. Returns the raw trade list (used for
// summarize(), the per-session breakdown, and walk-forward stitching).
function runEngine(candles, signalFn, opts = {}) {
  const fixedContracts = opts.fixedContracts ?? null // null = existing $500-cap risk-adjusted sizing (unchanged default)
  let pos = null, entryIdx = null, entryPrice = null, stopPrice = null, targetPrice = null, side = null
  let lastExitIdx = -Infinity
  const trades = []
  let blockedByPolicy = 0

  // Known in advance, doesn't depend on the trade's outcome:
  const commissionInPoints  = (COMMISSION_PER_SIDE * 2) / POINT_VALUE
  const worstCaseSlipPoints = (SLIPPAGE_ENTRY_TICKS + SLIPPAGE_STOP_TICKS) * TICK_SIZE
  const frictionCostPoints  = commissionInPoints + worstCaseSlipPoints

  for (let i = 20; i < candles.length; i++) {
    const c = candles[i]

    if (pos) {
      const barsOpen = i - entryIdx
      let rawExit = null, reason = null, exitIsBuy = null
      if (side === 'long') {
        if (c.low  <= stopPrice)        { rawExit = stopPrice;   reason = 'stop';   exitIsBuy = false }
        else if (c.high >= targetPrice) { rawExit = targetPrice; reason = 'target'; exitIsBuy = false }
      } else {
        if (c.high >= stopPrice)        { rawExit = stopPrice;   reason = 'stop';   exitIsBuy = true }
        else if (c.low  <= targetPrice) { rawExit = targetPrice; reason = 'target'; exitIsBuy = true }
      }
      if (rawExit == null && barsOpen >= MAX_HOLD_BARS) {
        rawExit = c.close; reason = 'time'; exitIsBuy = side === 'short'
      }

      if (rawExit != null) {
        const slipTicks = reason === 'stop' ? SLIPPAGE_STOP_TICKS
          : reason === 'target' ? SLIPPAGE_TARGET_TICKS
          : SLIPPAGE_ENTRY_TICKS
        const exitPrice = slip(rawExit, exitIsBuy, slipTicks)

        const dir = side === 'long' ? 1 : -1
        const stopDist = Math.abs(entryPrice - stopPrice)
        const contracts = fixedContracts != null
          ? fixedContracts
          : (stopDist > 0 ? Math.max(1, Math.min(6, Math.floor(MAX_LOSS_DOLLARS / (stopDist * POINT_VALUE)))) : 1)
        const grossPnl = dir * (exitPrice - entryPrice) * POINT_VALUE * contracts
        const commission = COMMISSION_PER_SIDE * 2 * contracts // entry + exit
        const dollarPnl = grossPnl - commission
        const rMult = stopDist > 0 ? dir * (exitPrice - entryPrice) / stopDist : 0

        // entrySession: the session the trade was OPENED in — what a router
        // would have used to route it. Used for the per-session breakdown.
        trades.push({
          entryIdx, exitIdx: i, side, entryPrice, exitPrice, contracts,
          grossPnl: +grossPnl.toFixed(2), commission: +commission.toFixed(2),
          dollarPnl: +dollarPnl.toFixed(2), rMult, reason, barsHeld: barsOpen,
          time: candles[entryIdx].time,
          exitTime: c.time,
          session: getSession(candles[entryIdx].time),
        })
        pos = null; lastExitIdx = i
      }
      continue
    }

    if (i - lastExitIdx < COOLDOWN_BARS) continue

    const action = signalFn(i)
    if (action !== 'buy' && action !== 'sell') continue

    const atr = calcATR(candles, i)
    const dist = atr * STOP_ATR_MULT
    if (dist <= 0) continue

    // Stage X — Decision Policy gate. Reject before opening if friction
    // alone would consume too large a share of this trade's stop distance.
    if (frictionCostPoints > dist * MAX_FRICTION_TO_R_RATIO) {
      blockedByPolicy++
      continue
    }

    side = action === 'buy' ? 'long' : 'short'
    const rawEntry = c.close
    entryPrice  = slip(rawEntry, side === 'long', SLIPPAGE_ENTRY_TICKS)
    stopPrice   = side === 'long' ? entryPrice - dist : entryPrice + dist
    targetPrice = side === 'long' ? entryPrice + dist * R_MULTIPLE : entryPrice - dist * R_MULTIPLE
    entryIdx = i
    pos = true
  }
  return { trades, blockedByPolicy }
}

function summarize(trades) {
  if (!trades.length) return { trades: 0, winRate: 0, expectancyR: 0, totalDollar: 0, maxDD: 0, totalCommission: 0, winRateLower: 0, winRateUpper: 0 }
  const wins = trades.filter((t) => t.dollarPnl > 0)
  const expectancyR = trades.reduce((s, t) => s + t.rMult, 0) / trades.length
  const totalDollar = trades.reduce((s, t) => s + t.dollarPnl, 0)
  const totalCommission = trades.reduce((s, t) => s + t.commission, 0)
  let equity = 0, peak = 0, maxDD = 0
  for (const t of trades) {
    equity += t.dollarPnl
    peak = Math.max(peak, equity)
    maxDD = Math.max(maxDD, peak - equity)
  }
  const wilson = wilsonInterval(wins.length, trades.length)
  return {
    trades: trades.length,
    winRate: +((wins.length / trades.length) * 100).toFixed(1),
    winRateLower: +(wilson.lower * 100).toFixed(1),
    winRateUpper: +(wilson.upper * 100).toFixed(1),
    expectancyR: +expectancyR.toFixed(3),
    totalDollar: +totalDollar.toFixed(0),
    maxDD: +maxDD.toFixed(0),
    totalCommission: +totalCommission.toFixed(0),
  }
}

function passesBar(stats) {
  return stats.trades >= PASS_BAR.minTrades && stats.expectancyR >= PASS_BAR.minExpectancyR
}

// A raw win-rate percentage means very little on its own at small sample
// sizes \u2014 a normal-approximation interval badly understates uncertainty
// when n is small. The Wilson score interval corrects for this. On n=11
// (H2c\u0027s Asian-session \u2605, 54.5% win rate), the true 95% interval is
// roughly [28%, 79%] \u2014 not the tight band the raw number implies.
function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return { lower: 0, upper: 0, center: 0 }
  const p = wins / n
  const denom  = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), center }
}

// ── Raw trade export ──────────────────────────────────────────────
// For bottom-up pattern hunting: every hypothesis tested so far was built
// top-down (from a video or a general theory) and none survived contact
// with honest out-of-sample testing. Looking at actual individual trades
// by hand — not just aggregated stats — is the next real step: hunting
// for something specific that predicts win vs loss, the way a real edge
// is usually found, rather than generating another top-down hypothesis.
function tradesToCSV(trades) {
  const headers = ['entryTime', 'exitTime', 'session', 'side', 'entryPrice', 'exitPrice', 'contracts', 'rMult', 'dollarPnl', 'grossPnl', 'commission', 'reason', 'barsHeld']
  const rows = trades.map((t) => [
    new Date(t.time).toISOString(),
    new Date(t.exitTime).toISOString(),
    t.session,
    t.side,
    t.entryPrice.toFixed(2),
    t.exitPrice.toFixed(2),
    t.contracts,
    t.rMult.toFixed(3),
    t.dollarPnl.toFixed(2),
    t.grossPnl.toFixed(2),
    t.commission.toFixed(2),
    t.reason,
    t.barsHeld,
  ].join(','))
  return [headers.join(','), ...rows].join('\n')
}

function downloadCSV(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── UI ────────────────────────────────────────────────────────────
function MonthPicker({ label, selected, onToggle, disabledKeys }) {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="lbl" style={{ margin: 0 }}>{label}</label>
        <span className="spacer" />
        <span style={{ fontSize: 11, color: 'var(--blue)' }}>
          {selected.length} month{selected.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
        gap: 6, maxHeight: 160, overflowY: 'auto',
      }}>
        {AVAILABLE_MONTHS.map((m) => {
          const isSel = !!selected.find((s) => s.key === m.key)
          const isDisabled = disabledKeys && disabledKeys.has(m.key) && !isSel
          return (
            <button
              key={m.key}
              disabled={isDisabled}
              onClick={() => onToggle(m)}
              style={{
                padding: '6px 8px', borderRadius: 6,
                border: `1px solid ${isSel ? 'var(--blue)' : 'var(--border)'}`,
                background: isSel ? 'rgba(45,108,223,0.15)' : 'var(--surface)',
                color: isDisabled ? 'var(--text-dim)' : isSel ? 'var(--blue)' : 'var(--text-muted)',
                fontSize: 11, fontWeight: isSel ? 600 : 400,
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                opacity: isDisabled ? 0.4 : 1,
              }}
            >
              {m.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function StatRow({ label, stats, isPass }) {
  if (!stats) return (
    <tr><td style={{ padding: '6px 8px', color: 'var(--text-dim)' }}>{label}</td><td colSpan={6} style={{ color: 'var(--text-dim)', fontSize: 12 }}>not run</td></tr>
  )
  const pnlColor = stats.totalDollar > 0 ? 'var(--green)' : stats.totalDollar < 0 ? 'var(--red)' : 'var(--text-muted)'
  return (
    <tr>
      <td style={{ padding: '6px 8px' }}>{label}</td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{stats.trades}</td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
        {stats.winRate}%
        <span style={{ color: 'var(--text-dim)', fontSize: 10 }}> [{stats.winRateLower}\u2013{stats.winRateUpper}]</span>
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{stats.expectancyR >= 0 ? '+' : ''}{stats.expectancyR}R</td>
      <td style={{ padding: '6px 8px', textAlign: 'right', color: pnlColor }}>
        {stats.totalDollar >= 0 ? '+' : ''}${stats.totalDollar}
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>-${stats.maxDD}</td>
      <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-dim)' }}>-${stats.totalCommission}</td>
      <td style={{ padding: '6px 8px', textAlign: 'center' }}>
        {isPass ? <span style={{ color: 'var(--green)' }}>\u2713 pass</span> : <span style={{ color: 'var(--text-dim)' }}>\u2014</span>}
      </td>
    </tr>
  )
}

// Compact by-session table — trades / win% / P&L only, no repeated headers
// from the main stats table. Used under both Train results and walk-forward
// stitched results, since those are the two datasets worth checking a
// session router against (Train = exploration, stitched = larger sample).
function SessionBreakdown({ bySession, label }) {
  const totalTrades = SESSIONS.reduce((s, k) => s + (bySession[k]?.trades || 0), 0)
  if (!totalTrades) return null
  const best = SESSIONS
    .filter((s) => bySession[s].trades >= 10)
    .sort((a, b) => bySession[b].expectancyR - bySession[a].expectancyR)[0]
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>By session ({label})</div>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
            <th style={{ textAlign: 'left', padding: '3px 6px' }}>Session</th>
            <th style={{ padding: '3px 6px' }}>Trades</th>
            <th style={{ padding: '3px 6px' }}>Win%</th>
            <th style={{ padding: '3px 6px' }}>Expectancy</th>
            <th style={{ padding: '3px 6px' }}>P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {SESSIONS.map((s) => {
            const st = bySession[s]
            const isBest = best === s && st.trades >= 10
            return (
              <tr key={s} style={isBest ? { background: 'rgba(76,175,80,0.06)' } : undefined}>
                <td style={{ padding: '3px 6px' }}>{s}{isBest ? ' \u2605' : ''}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{st.trades}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{st.trades ? `${st.winRate}%` : '\u2014'}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{st.trades ? `${st.expectancyR >= 0 ? '+' : ''}${st.expectancyR}R` : '\u2014'}</td>
                <td style={{
                  padding: '3px 6px', textAlign: 'right',
                  color: !st.trades ? 'var(--text-dim)' : st.totalDollar > 0 ? 'var(--green)' : st.totalDollar < 0 ? 'var(--red)' : 'var(--text-muted)',
                }}>
                  {st.trades ? `${st.totalDollar >= 0 ? '+' : ''}$${st.totalDollar}` : '\u2014'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
        \u2605 = best expectancy among sessions with \u226510 trades. A single session standing out here, consistently
        across Train and walk-forward, is what would justify building a session router \u2014 not a guess.
      </p>
    </div>
  )
}

function DownloadButton({ trades, filename, label }) {
  if (!trades || !trades.length) return null
  return (
    <button
      className="btn-sm"
      onClick={() => downloadCSV(filename, tradesToCSV(trades))}
      style={{ fontSize: 11, padding: '4px 10px', marginTop: 8, marginRight: 6 }}
    >
      \u2b07 {label} ({trades.length} trades)
    </button>
  )
}

function FeatureBucketTable({ title, buckets, unit }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>{title}</div>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
            <th style={{ textAlign: 'left', padding: '3px 6px' }}>Quintile (low\u2192high)</th>
            <th style={{ padding: '3px 6px' }}>n</th>
            <th style={{ padding: '3px 6px' }}>Win% [Wilson]</th>
            <th style={{ padding: '3px 6px' }}>Mean R</th>
            <th style={{ padding: '3px 6px' }}>95% CI</th>
            <th style={{ padding: '3px 6px' }}>P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => {
            const ciCrossesZero = b.lower < 0 && b.upper > 0
            return (
              <tr key={i}>
                <td style={{ padding: '3px 6px' }}>Q{i + 1} ({b.featureRange[0]}{unit}\u2013{b.featureRange[1]}{unit})</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{b.n}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                  {b.winRate}% <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>[{b.winRateLower}\u2013{b.winRateUpper}]</span>
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{b.meanR >= 0 ? '+' : ''}{b.meanR}R</td>
                <td style={{ padding: '3px 6px', textAlign: 'right', color: ciCrossesZero ? 'var(--text-dim)' : (b.lower > 0 ? 'var(--green)' : 'var(--red)') }}>
                  [{b.lower}, {b.upper}]
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right', color: b.totalDollar > 0 ? 'var(--green)' : b.totalDollar < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
                  {b.totalDollar >= 0 ? '+' : ''}\${b.totalDollar}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function JointBucketTable({ buckets }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
        Joint breakdown (trend \u00d7 ATR \u00d7 wick, sorted best to worst)
      </div>
      <p style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 6, lineHeight: 1.5 }}>
        8 smaller cells from the same data \u2014 more multiple-comparisons risk than the single-feature
        tables above, not less. One cell looking good here is weaker evidence than a monotonic trend
        across quantiles, not stronger.
      </p>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
            <th style={{ textAlign: 'left', padding: '3px 6px' }}>Combination</th>
            <th style={{ padding: '3px 6px' }}>n</th>
            <th style={{ padding: '3px 6px' }}>Win% [Wilson]</th>
            <th style={{ padding: '3px 6px' }}>Mean R</th>
            <th style={{ padding: '3px 6px' }}>95% CI</th>
            <th style={{ padding: '3px 6px' }}>P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => {
            const ciCrossesZero = b.lower < 0 && b.upper > 0
            return (
              <tr key={i}>
                <td style={{ padding: '3px 6px' }}>{b.label}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{b.n}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                  {b.winRate}% <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>[{b.winRateLower}\u2013{b.winRateUpper}]</span>
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{b.meanR >= 0 ? '+' : ''}{b.meanR}R</td>
                <td style={{ padding: '3px 6px', textAlign: 'right', color: ciCrossesZero ? 'var(--text-dim)' : (b.lower > 0 ? 'var(--green)' : 'var(--red)') }}>
                  [{b.lower}, {b.upper}]
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right', color: b.totalDollar > 0 ? 'var(--green)' : b.totalDollar < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
                  {b.totalDollar >= 0 ? '+' : ''}\${b.totalDollar}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Sparkline({ values, width = 110, height = 32, color = 'var(--blue)' }) {
  if (!values || values.length < 2) return null
  const min = Math.min(...values), max = Math.max(...values)
  const range = max - min || 1
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  )
}

function GapWarning({ gaps }) {
  if (!gaps.length) return null
  return (
    <div className="card" style={{ borderColor: 'rgba(240,160,32,0.3)', background: 'rgba(240,160,32,0.06)' }}>
      <div className="card-title" style={{ color: 'var(--amber)' }}>
        {gaps.length} suspicious gap{gaps.length !== 1 ? 's' : ''} in this data
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {gaps.length} bar{gaps.length !== 1 ? 's are' : ' is'} {'>'}1.5% away from the prior bar with only a
        few minutes between them \u2014 not normal price action. This is what an un-stitched futures contract
        roll looks like in the raw data. Worth checking massiveFinance.js's rollover handling before trusting
        results run on these months. Largest: {Math.max(...gaps.map((g) => g.pctMove))}%.
      </p>
    </div>
  )
}

export default function HypothesisLab() {
  const [trainMonths, setTrainMonths]       = useState([])
  const [validateMonths, setValidateMonths] = useState([])
  const [testMonths, setTestMonths]         = useState([])
  const [running, setRunning]               = useState(false)
  const [loadMsg, setLoadMsg]               = useState('')
  const [error, setError]                   = useState('')
  const [results, setResults]               = useState(null) // { [hypId]: { train, trainBySession, validate, test } }
  const [gapWarnings, setGapWarnings]       = useState([])

  const [wfMonths, setWfMonths]     = useState([])
  const [wfRunning, setWfRunning]   = useState(false)
  const [wfLoadMsg, setWfLoadMsg]   = useState('')
  const [wfError, setWfError]       = useState('')
  const [wfResults, setWfResults]   = useState(null) // { [hypId]: { perMonth, stitched, stitchedBySession, profitableCount, totalCount } }

  const [ceMonths, setCeMonths]     = useState([])
  const [ceRunning, setCeRunning]   = useState(false)
  const [ceLoadMsg, setCeLoadMsg]   = useState('')
  const [ceError, setCeError]       = useState('')
  const [ceResults, setCeResults]   = useState(null) // { totalEvents, resolvedEvents, byRecentRange, byWickSize, byTrendSteepness }

  const [gaMonths, setGaMonths]     = useState([])
  const [gaRunning, setGaRunning]   = useState(false)
  const [gaLoadMsg, setGaLoadMsg]   = useState('')
  const [gaError, setGaError]       = useState('')
  const [gaResults, setGaResults]   = useState(null) // { totalEvents, resolvedEvents, byGapMagnitude }

  const [ptHypId, setPtHypId]       = useState(HYPOTHESES[0].id)
  const [ptMonths, setPtMonths]     = useState([])
  const [ptRunning, setPtRunning]   = useState(false)
  const [ptLoadMsg, setPtLoadMsg]   = useState('')
  const [ptError, setPtError]       = useState('')
  const [ptResults, setPtResults]   = useState(null)

  const [scHypId, setScHypId]       = useState('h8_ma_cross_session')
  const [scMonths, setScMonths]     = useState([])
  const [scRunning, setScRunning]   = useState(false)
  const [scLoadMsg, setScLoadMsg]   = useState('')
  const [scError, setScError]       = useState('')
  const [scResults, setScResults]   = useState(null) // { riskAdjusted, fixed6 }

  const [pmMonths, setPmMonths]     = useState([])
  const [pmRunning, setPmRunning]   = useState(false)
  const [pmLoadMsg, setPmLoadMsg]   = useState('')
  const [pmError, setPmError]       = useState('')
  const [pmResults, setPmResults]   = useState(null)

  const [gridMonths, setGridMonths]     = useState([])
  const [gridRunning, setGridRunning]   = useState(false)
  const [gridLoadMsg, setGridLoadMsg]   = useState('')
  const [gridError, setGridError]       = useState('')
  const [gridResults, setGridResults]   = useState(null)

  const [h9Months, setH9Months]     = useState([])
  const [h9Running, setH9Running]   = useState(false)
  const [h9LoadMsg, setH9LoadMsg]   = useState('')
  const [h9Error, setH9Error]       = useState('')
  const [h9Results, setH9Results]   = useState(null)

  const [imMonths, setImMonths]     = useState([])
  const [imRunning, setImRunning]   = useState(false)
  const [imLoadMsg, setImLoadMsg]   = useState('')
  const [imError, setImError]       = useState('')
  const [imResults, setImResults]   = useState(null)

  const [smcMonths, setSmcMonths]     = useState([])
  const [smcRunning, setSmcRunning]   = useState(false)
  const [smcLoadMsg, setSmcLoadMsg]   = useState('')
  const [smcError, setSmcError]       = useState('')
  const [smcResults, setSmcResults]   = useState(null)

  const usedKeys = new Set([...trainMonths, ...validateMonths, ...testMonths].map((m) => m.key))

  function toggle(setBucket) {
    return (m) => setBucket((prev) => {
      const exists = prev.find((s) => s.key === m.key)
      return exists ? prev.filter((s) => s.key !== m.key) : [...prev, m]
    })
  }

  async function runAll() {
    if (!trainMonths.length) { setError('Select at least one Train month \u2014 Validate and Test are optional but Train is required.'); return }
    setError('')
    setRunning(true)
    setResults(null)
    setGapWarnings([])
    try {
      setLoadMsg('Fetching Train candles\u2026')
      const trainCandles = await fetchSelectedMonths(SYMBOL, '5min', [...trainMonths].sort((a, b) => a.key.localeCompare(b.key)))
      // TEMPORARY DIAGNOSTIC \u2014 checking whether candles include a volume field.
      // Safe to remove once confirmed; open the browser console (F12) before clicking Run.
      console.log('[VOLUME CHECK] Sample candle object:', trainCandles[0])
      console.log('[VOLUME CHECK] Keys present on this candle:', trainCandles[0] ? Object.keys(trainCandles[0]) : 'no candles returned')
      console.log('[TICKER CHECK] Available futures symbols from massiveFinance:', FUTURES_SYMBOLS)
      let validateCandles = []
      let testCandles = []
      if (validateMonths.length) {
        setLoadMsg('Fetching Validate candles\u2026')
        validateCandles = await fetchSelectedMonths(SYMBOL, '5min', [...validateMonths].sort((a, b) => a.key.localeCompare(b.key)))
      }
      if (testMonths.length) {
        setLoadMsg('Fetching Test candles\u2026')
        testCandles = await fetchSelectedMonths(SYMBOL, '5min', [...testMonths].sort((a, b) => a.key.localeCompare(b.key)))
      }

      const allGaps = [
        ...detectSuspiciousGaps(trainCandles),
        ...detectSuspiciousGaps(validateCandles),
        ...detectSuspiciousGaps(testCandles),
      ]
      setGapWarnings(allGaps)

      setLoadMsg('Running hypotheses\u2026')
      const out = {}
      for (const hyp of HYPOTHESES) {
        const trainFn = hyp.makeSignal(trainCandles)
        const { trades: trainTrades, blockedByPolicy: trainBlocked } = runEngine(trainCandles, trainFn)
        const trainStats = summarize(trainTrades)
        const trainBySession = summarizeBySession(trainTrades)

        let validateStats = null
        let testStats = null
        let validateBlocked = 0
        let testBlocked = 0
        let validateTrades = []
        let testTrades = []
        if (passesBar(trainStats)) {
          if (validateCandles.length) {
            const vFn = hyp.makeSignal(validateCandles)
            const vResult = runEngine(validateCandles, vFn)
            validateStats = summarize(vResult.trades)
            validateBlocked = vResult.blockedByPolicy
            validateTrades = vResult.trades
          }
          if (testCandles.length && (!validateCandles.length || passesBar(validateStats))) {
            const tFn = hyp.makeSignal(testCandles)
            const tResult = runEngine(testCandles, tFn)
            testStats = summarize(tResult.trades)
            testBlocked = tResult.blockedByPolicy
            testTrades = tResult.trades
          }
        }

        out[hyp.id] = {
          train: trainStats, trainBySession, trainBlocked, trainTrades,
          validate: validateStats, validateBlocked, validateTrades,
          test: testStats, testBlocked, testTrades,
        }
      }
      setResults(out)
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
      setLoadMsg('')
    }
  }

  async function runWalkForward() {
    if (wfMonths.length < 2) { setWfError('Select at least 2 months \u2014 walk-forward needs several months to be meaningful.'); return }
    setWfError('')
    setWfRunning(true)
    setWfResults(null)
    try {
      const sorted = [...wfMonths].sort((a, b) => a.key.localeCompare(b.key))
      const perMonthCandles = []
      for (const m of sorted) {
        setWfLoadMsg(`Fetching ${m.label}\u2026`)
        const candles = await fetchSelectedMonths(SYMBOL, '5min', [m])
        perMonthCandles.push({ month: m, candles })
      }

      setWfLoadMsg('Running hypotheses month by month\u2026')
      const out = {}
      for (const hyp of HYPOTHESES) {
        const perMonth = []
        let stitchedTrades = []
        let totalBlocked = 0
        for (const { month, candles } of perMonthCandles) {
          if (!candles.length) { perMonth.push({ month: month.label, stats: null }); continue }
          const fn = hyp.makeSignal(candles)
          const { trades, blockedByPolicy } = runEngine(candles, fn)
          const stats = summarize(trades)
          perMonth.push({ month: month.label, stats })
          stitchedTrades = stitchedTrades.concat(trades)
          totalBlocked += blockedByPolicy
        }
        stitchedTrades.sort((a, b) => a.time - b.time)
        const stitched = summarize(stitchedTrades)
        const stitchedBySession = summarizeBySession(stitchedTrades)
        const monthsWithTrades = perMonth.filter((p) => p.stats && p.stats.trades > 0)
        const profitableCount = monthsWithTrades.filter((p) => p.stats.totalDollar > 0).length
        out[hyp.id] = { perMonth, stitched, stitchedBySession, stitchedTrades, profitableCount, totalCount: monthsWithTrades.length, totalBlocked }
      }
      setWfResults(out)
    } catch (e) {
      setWfError(e.message)
    } finally {
      setWfRunning(false)
      setWfLoadMsg('')
    }
  }

  async function runContextExplorerUI() {
    if (!ceMonths.length) { setCeError('Select at least one month.'); return }
    setCeError('')
    setCeRunning(true)
    setCeResults(null)
    try {
      setCeLoadMsg('Fetching candles\u2026')
      const candles = await fetchSelectedMonths(SYMBOL, '5min', [...ceMonths].sort((a, b) => a.key.localeCompare(b.key)))
      setCeLoadMsg('Detecting events and computing contextual features\u2026')
      const result = runContextExplorer(candles)
      setCeResults(result)
    } catch (e) {
      setCeError(e.message)
    } finally {
      setCeRunning(false)
      setCeLoadMsg('')
    }
  }

  async function runGapAnalysisUI() {
    if (!gaMonths.length) { setGaError('Select at least one month.'); return }
    setGaError('')
    setGaRunning(true)
    setGaResults(null)
    try {
      setGaLoadMsg('Fetching candles\u2026')
      const candles = await fetchSelectedMonths(SYMBOL, '5min', [...gaMonths].sort((a, b) => a.key.localeCompare(b.key)))
      setGaLoadMsg('Detecting ORB events and computing gap magnitude\u2026')
      const result = runGapAnalysis(candles)
      setGaResults(result)
    } catch (e) {
      setGaError(e.message)
    } finally {
      setGaRunning(false)
      setGaLoadMsg('')
    }
  }

  async function runPermutationTestUI() {
    if (!ptMonths.length) { setPtError('Select at least one month.'); return }
    setPtError('')
    setPtRunning(true)
    setPtResults(null)
    try {
      setPtLoadMsg('Fetching candles\u2026')
      const candles = await fetchSelectedMonths(SYMBOL, '5min', [...ptMonths].sort((a, b) => a.key.localeCompare(b.key)))
      const hyp = HYPOTHESES.find((h) => h.id === ptHypId)
      setPtLoadMsg('Running 200 permutations\u2026 this takes a while')
      // yield one tick so the loading message actually paints before the
      // synchronous permutation loop blocks the thread
      await new Promise((resolve) => setTimeout(resolve, 30))
      const result = runPermutationTest(candles, hyp, 200)
      setPtResults(result)
    } catch (e) {
      setPtError(e.message)
    } finally {
      setPtRunning(false)
      setPtLoadMsg('')
    }
  }

  async function runSmcStrategyUI() {
    if (!smcMonths.length) { setSmcError('Select at least one month.'); return }
    setSmcError('')
    setSmcRunning(true)
    setSmcResults(null)
    try {
      setSmcLoadMsg(`Fetching ${INTERMARKET_SYMBOL} candles\u2026`)
      const candles = await fetchSelectedMonths(INTERMARKET_SYMBOL, '15min', [...smcMonths].sort((a, b) => a.key.localeCompare(b.key)))
      setSmcLoadMsg('Running SMC strategy simulation\u2026')
      await new Promise((resolve) => setTimeout(resolve, 30))
      const trades = simulateSMCStrategy(candles)
      const wins = trades.filter((t) => t.dollarPnl > 0)
      const totalDollar = trades.reduce((s, t) => s + t.dollarPnl, 0)
      const byEntryType = {}
      const byExitReason = {}
      for (const t of trades) {
        byEntryType[t.entryType] = (byEntryType[t.entryType] || 0) + 1
        byExitReason[t.reason] = (byExitReason[t.reason] || 0) + 1
      }
      setSmcResults({
        trades, totalDollar,
        winRate: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : 0,
        byEntryType, byExitReason,
      })
    } catch (e) {
      setSmcError(e.message)
    } finally {
      setSmcRunning(false)
      setSmcLoadMsg('')
    }
  }

  async function runIntermarketMinerUI() {
    if (!imMonths.length) { setImError('Select at least one month.'); return }
    setImError('')
    setImRunning(true)
    setImResults(null)
    try {
      setImLoadMsg('Fetching NQ candles\u2026')
      const nqCandles = await fetchSelectedMonths(SYMBOL, '5min', [...imMonths].sort((a, b) => a.key.localeCompare(b.key)))
      setImLoadMsg(`Fetching ${INTERMARKET_SYMBOL} candles\u2026`)
      const esCandles = await fetchSelectedMonths(INTERMARKET_SYMBOL, '5min', [...imMonths].sort((a, b) => a.key.localeCompare(b.key)))
      setImLoadMsg('Aligning, computing spread, mining shapes\u2026')
      await new Promise((resolve) => setTimeout(resolve, 30))
      const result = mineIntermarketPatterns(nqCandles, esCandles)
      setImResults(result)
    } catch (e) {
      setImError(e.message)
    } finally {
      setImRunning(false)
      setImLoadMsg('')
    }
  }

  async function runH9GridUI() {
    if (!h9Months.length) { setH9Error('Select at least one month.'); return }
    setH9Error('')
    setH9Running(true)
    setH9Results(null)
    try {
      setH9LoadMsg('Fetching candles\u2026')
      const candles = await fetchSelectedMonths(SYMBOL, '5min', [...h9Months].sort((a, b) => a.key.localeCompare(b.key)))

      setH9LoadMsg('Running real 42-combination neighborhood\u2026')
      await new Promise((resolve) => setTimeout(resolve, 30))
      const realResults = runH9NeighborhoodGrid(candles)
      const realBest = realResults[0] || null

      if (!realBest) {
        setH9Results({ results: realResults, best: null, permutationSkipped: true })
        return
      }

      const numPermutations = 100
      let asGoodOrBetter = 0
      const permBests = []
      for (let p = 0; p < numPermutations; p++) {
        setH9LoadMsg(`Running permutation ${p + 1} of ${numPermutations}\u2026`)
        await new Promise((resolve) => setTimeout(resolve, 0))
        const permuted = permuteBars(candles, 0)
        const permResults = runH9NeighborhoodGrid(permuted)
        const bestR = (permResults[0] && permResults[0].expectancyR) ?? -Infinity
        permBests.push(bestR)
        if (bestR >= realBest.expectancyR) asGoodOrBetter++
      }
      permBests.sort((a, b) => a - b)
      setH9Results({
        results: realResults,
        best: realBest,
        pValue: asGoodOrBetter / numPermutations,
        numPermutations,
        permMin: permBests[0],
        permMedian: permBests[Math.floor(permBests.length / 2)],
        permMax: permBests[permBests.length - 1],
      })
    } catch (e) {
      setH9Error(e.message)
    } finally {
      setH9Running(false)
      setH9LoadMsg('')
    }
  }

  async function runGridUI() {
    if (!gridMonths.length) { setGridError('Select at least one month.'); return }
    setGridError('')
    setGridRunning(true)
    setGridResults(null)
    try {
      setGridLoadMsg('Fetching candles\u2026')
      const candles = await fetchSelectedMonths(SYMBOL, '5min', [...gridMonths].sort((a, b) => a.key.localeCompare(b.key)))

      setGridLoadMsg('Running real grid (240 combinations)\u2026')
      await new Promise((resolve) => setTimeout(resolve, 30))
      const realResults = runFullGrid(candles)
      const realBest = realResults[0] || null

      if (!realBest) {
        setGridResults({ results: realResults, best: null, permutationSkipped: true })
        return
      }

      const numPermutations = 20
      let asGoodOrBetter = 0
      const permBests = []
      for (let p = 0; p < numPermutations; p++) {
        setGridLoadMsg(`Running permutation ${p + 1} of ${numPermutations} (full grid each time)\u2026`)
        await new Promise((resolve) => setTimeout(resolve, 0)) // yield so the UI stays responsive across this multi-minute loop
        const permuted = permuteBars(candles, 0)
        const permResults = runFullGrid(permuted)
        const bestR = (permResults[0] && permResults[0].expectancyR) ?? -Infinity
        permBests.push(bestR)
        if (bestR >= realBest.expectancyR) asGoodOrBetter++
      }
      permBests.sort((a, b) => a - b)
      setGridResults({
        results: realResults,
        best: realBest,
        pValue: asGoodOrBetter / numPermutations,
        numPermutations,
        permMin: permBests[0],
        permMedian: permBests[Math.floor(permBests.length / 2)],
        permMax: permBests[permBests.length - 1],
      })
    } catch (e) {
      setGridError(e.message)
    } finally {
      setGridRunning(false)
      setGridLoadMsg('')
    }
  }

  async function runPatternMinerUI() {
    if (!pmMonths.length) { setPmError('Select at least one month.'); return }
    setPmError('')
    setPmRunning(true)
    setPmResults(null)
    try {
      setPmLoadMsg('Fetching candles\u2026')
      const candles = await fetchSelectedMonths(SYMBOL, '5min', [...pmMonths].sort((a, b) => a.key.localeCompare(b.key)))
      setPmLoadMsg('Extracting patterns, clustering, and running 20 permutations\u2026 this takes a while')
      await new Promise((resolve) => setTimeout(resolve, 30))
      const result = runMiningPermutationTest(candles, {}, 20)
      setPmResults(result)
    } catch (e) {
      setPmError(e.message)
    } finally {
      setPmRunning(false)
      setPmLoadMsg('')
    }
  }

  async function runSizingComparisonUI() {
    if (!scMonths.length) { setScError('Select at least one month.'); return }
    setScError('')
    setScRunning(true)
    setScResults(null)
    try {
      setScLoadMsg('Fetching candles\u2026')
      const candles = await fetchSelectedMonths(SYMBOL, '5min', [...scMonths].sort((a, b) => a.key.localeCompare(b.key)))
      const hyp = HYPOTHESES.find((h) => h.id === scHypId)
      setScLoadMsg('Running both sizing modes\u2026')
      const fn1 = hyp.makeSignal(candles)
      const riskAdjusted = summarize(runEngine(candles, fn1).trades)
      const fn2 = hyp.makeSignal(candles)
      const fixed6 = summarize(runEngine(candles, fn2, { fixedContracts: 6 }).trades)
      setScResults({ riskAdjusted, fixed6 })
    } catch (e) {
      setScError(e.message)
    } finally {
      setScRunning(false)
      setScLoadMsg('')
    }
  }

  return (
    <div>
      <div className="card">
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Hypothesis Lab</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Isolated from the live signal pipeline \u2014 nothing here touches active_strategy,
          paper_trades, or the live bot. Every trade below pays commission (\u2248${(COMMISSION_PER_SIDE * 2).toFixed(2)}/contract
          round trip) and slippage ({SLIPPAGE_ENTRY_TICKS}\u2013{SLIPPAGE_STOP_TICKS} ticks depending on fill type). Before a signal
          becomes a trade it also passes a Decision Policy gate (Stage X) \u2014 blocked if friction alone would exceed
          {Math.round(MAX_FRICTION_TO_R_RATIO * 100)}% of that trade's stop distance, since a real edge can't survive costs eating
          that much of 1R regardless of entry quality. Pass bar: \u2265{PASS_BAR.minTrades} trades and \u2265+{PASS_BAR.minExpectancyR}R
          expectancy on Train, after friction.
        </p>
      </div>

      <div className="card">
        <div className="card-title">1. Train / Validate / Test split</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
          One out-of-sample data point. Good first filter \u2014 follow with walk-forward below before trusting anything.
          Each hypothesis's Train result also shows a by-session breakdown \u2014 use it to see whether any hypothesis
          performs differently by session before considering a session router.
        </p>
      </div>

      <MonthPicker label="Train (tuning allowed)" selected={trainMonths} onToggle={toggle(setTrainMonths)} disabledKeys={usedKeys} />
      <MonthPicker label="Validate (one look, no changes after)" selected={validateMonths} onToggle={toggle(setValidateMonths)} disabledKeys={usedKeys} />
      <MonthPicker label="Test (touch once, at the very end)" selected={testMonths} onToggle={toggle(setTestMonths)} disabledKeys={usedKeys} />

      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runAll} disabled={running} style={{ flex: 1, padding: '11px' }}>
          {running ? `\u23f3 ${loadMsg}` : '\u25b6 Run Train / Validate / Test'}
        </button>
      </div>

      <GapWarning gaps={gapWarnings} />

      {results && HYPOTHESES.map((hyp) => {
        const r = results[hyp.id]
        const trainPass = passesBar(r.train)
        const validatePass = r.validate ? passesBar(r.validate) : null
        const testPass = r.test ? passesBar(r.test) : null
        return (
          <div key={hyp.id} className="card">
            <div className="card-title">{hyp.name}</div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>{hyp.description}</p>
            {hyp.needsVolumeCheck && r.train.trades === 0 && (
              <p style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 8 }}>
                0 trades \u2014 check whether your cached candles include volume data before reading this as "no edge."
              </p>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Bucket</th>
                    <th style={{ padding: '4px 8px' }}>Trades</th>
                    <th style={{ padding: '4px 8px' }}>Win%</th>
                    <th style={{ padding: '4px 8px' }}>Expectancy</th>
                    <th style={{ padding: '4px 8px' }}>P&amp;L</th>
                    <th style={{ padding: '4px 8px' }}>Max DD</th>
                    <th style={{ padding: '4px 8px' }}>Commission</th>
                    <th style={{ padding: '4px 8px' }}>Gate</th>
                  </tr>
                </thead>
                <tbody>
                  <StatRow label="Train" stats={r.train} isPass={trainPass} />
                  <StatRow label="Validate" stats={r.validate} isPass={validatePass} />
                  <StatRow label="Test" stats={r.test} isPass={testPass} />
                </tbody>
              </table>
            </div>
            <SessionBreakdown bySession={r.trainBySession} label="Train" />
            {(r.trainBlocked || r.validateBlocked || r.testBlocked) ? (
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
                Blocked by Decision Policy (friction {'>'}{Math.round(MAX_FRICTION_TO_R_RATIO * 100)}% of stop distance):{' '}
                Train {r.trainBlocked}{r.validate ? `, Validate ${r.validateBlocked}` : ''}{r.test ? `, Test ${r.testBlocked}` : ''}
              </p>
            ) : null}
            <div style={{ marginTop: 4 }}>
              <DownloadButton trades={r.trainTrades} filename={`${hyp.id}_train.csv`} label="Train CSV" />
              <DownloadButton trades={r.validateTrades} filename={`${hyp.id}_validate.csv`} label="Validate CSV" />
              <DownloadButton trades={r.testTrades} filename={`${hyp.id}_test.csv`} label="Test CSV" />
            </div>
          </div>
        )
      })}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">2. Rolling walk-forward</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          These hypotheses are fixed rules \u2014 nothing is fit per month, so every month here is out-of-sample
          by construction. Pick a run of months; each hypothesis runs on every month independently, then all
          the trades get stitched into one chronological equity curve and broken down by session \u2014 a larger,
          more robust sample than Train alone for deciding if a session router is worth building.
        </p>
      </div>

      <MonthPicker label="Walk-forward months" selected={wfMonths} onToggle={toggle(setWfMonths)} />

      {wfError && <div className="error-box">{wfError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runWalkForward} disabled={wfRunning} style={{ flex: 1, padding: '11px' }}>
          {wfRunning ? `\u23f3 ${wfLoadMsg}` : '\u25b6 Run walk-forward'}
        </button>
      </div>

      {wfResults && HYPOTHESES.map((hyp) => {
        const r = wfResults[hyp.id]
        if (!r) return null
        return (
          <div key={hyp.id} className="card">
            <div className="card-title">{hyp.name}</div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
              Profitable in <strong style={{ color: r.profitableCount > r.totalCount / 2 ? 'var(--green)' : 'var(--red)' }}>
                {r.profitableCount} of {r.totalCount}
              </strong> months with trades.
            </p>
            <div style={{ overflowX: 'auto', marginBottom: 10 }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', padding: '3px 6px' }}>Month</th>
                    <th style={{ padding: '3px 6px' }}>Trades</th>
                    <th style={{ padding: '3px 6px' }}>Win%</th>
                    <th style={{ padding: '3px 6px' }}>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {r.perMonth.map((p) => (
                    <tr key={p.month}>
                      <td style={{ padding: '3px 6px' }}>{p.month}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right' }}>{p.stats ? p.stats.trades : '\u2014'}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right' }}>{p.stats ? `${p.stats.winRate}%` : '\u2014'}</td>
                      <td style={{
                        padding: '3px 6px', textAlign: 'right',
                        color: !p.stats ? 'var(--text-dim)' : p.stats.totalDollar > 0 ? 'var(--green)' : p.stats.totalDollar < 0 ? 'var(--red)' : 'var(--text-muted)',
                      }}>
                        {p.stats ? `${p.stats.totalDollar >= 0 ? '+' : ''}$${p.stats.totalDollar}` : '\u2014'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
              Stitched: {r.stitched.trades} trades, {r.stitched.winRate}% win rate, {r.stitched.expectancyR >= 0 ? '+' : ''}{r.stitched.expectancyR}R expectancy,{' '}
              <span style={{ color: r.stitched.totalDollar > 0 ? 'var(--green)' : 'var(--red)' }}>
                {r.stitched.totalDollar >= 0 ? '+' : ''}${r.stitched.totalDollar}
              </span>{' '}
              total, -${r.stitched.maxDD} max DD on the full stitched curve
            </div>
            <SessionBreakdown bySession={r.stitchedBySession} label="stitched" />
            {r.totalBlocked > 0 && (
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
                Blocked by Decision Policy across all months: {r.totalBlocked}
              </p>
            )}
            <div style={{ marginTop: 4 }}>
              <DownloadButton trades={r.stitchedTrades} filename={`${hyp.id}_walkforward_stitched.csv`} label="Stitched CSV" />
            </div>
          </div>
        )
      })}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">3. Event Context Explorer</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Separates the event (PDH/PDL sweep, same as H2 — just a timestamp flag, no entry decision)
          from contextual features that might explain why the same event produces different outcomes at
          different times: recent range (ATR), wick size on the event candle, and trend steepness (normalized
          20-SMA slope). These are exactly the things discretion usually weighs without naming — this
          quantifies them instead. Full quintile breakdown with 95% confidence intervals, not a single chosen
          threshold. A real relationship shows buckets separating with non-overlapping or clearly trending
          intervals across a real sample size — one bucket looking best on its own is not evidence; that
          exact pattern is what broke H7b.
        </p>
      </div>

      <MonthPicker label="Context Explorer months" selected={ceMonths} onToggle={toggle(setCeMonths)} />

      {ceError && <div className="error-box">{ceError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runContextExplorerUI} disabled={ceRunning} style={{ flex: 1, padding: '11px' }}>
          {ceRunning ? `\u23f3 ${ceLoadMsg}` : '\u25b6 Run Context Explorer'}
        </button>
      </div>

      {ceResults && (
        <div className="card">
          <div className="card-title">PDH/PDL Sweep \u2014 Contextual Breakdown</div>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
            {ceResults.totalEvents} events detected, {ceResults.resolvedEvents} resolved within {MAX_HOLD_BARS} bars.
          </p>
          <FeatureBucketTable title="By recent range (ATR at event, points)" buckets={ceResults.byRecentRange} unit="pt" />
          <FeatureBucketTable title="By wick size (fraction of candle range)" buckets={ceResults.byWickSize} unit="" />
          <FeatureBucketTable title="By trend steepness (5-bar % change of 20-SMA)" buckets={ceResults.byTrendSteepness} unit="" />
          <JointBucketTable buckets={ceResults.joint} />
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">3b. Gap Magnitude on Opening Range Breakout</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          A different event (H1\u2019s opening range breakout, not the PDH/PDL sweep) and a different
          feature: |today\u2019s open \u2212 yesterday\u2019s close| / ATR. Outside research found a clean,
          monotonic win-rate climb across quintiles with this exact feature on this exact event \u2014 worth
          checking directly rather than assuming it transfers.
        </p>
      </div>

      <MonthPicker label="Gap analysis months" selected={gaMonths} onToggle={toggle(setGaMonths)} />

      {gaError && <div className="error-box">{gaError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runGapAnalysisUI} disabled={gaRunning} style={{ flex: 1, padding: '11px' }}>
          {gaRunning ? `\u23f3 ${gaLoadMsg}` : '\u25b6 Run gap analysis'}
        </button>
      </div>

      {gaResults && (
        <div className="card">
          <div className="card-title">Opening Range Breakout \u2014 Gap Magnitude Breakdown</div>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
            {gaResults.totalEvents} ORB events detected, {gaResults.resolvedEvents} resolved with a usable prior-day gap.
          </p>
          <FeatureBucketTable title="By gap magnitude (|open \u2212 prior close| / ATR)" buckets={gaResults.byGapMagnitude} unit="" />
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">4. Monte Carlo Permutation Test</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          A different question than walk-forward: not "did this hold up on unseen months" but "is this
          result even distinguishable from what a worthless rule could produce by chance." Generates 200
          price-series permutations \u2014 same overall drift, mean, stdev, skew, and kurtosis as the real
          data, but the actual sequential pattern (trends, the specific highs/lows an event depends on) is
          destroyed \u2014 and runs the selected hypothesis on each one, unchanged. If the real expectancy
          isn\u2019t clearly better than most of the permutations, the rule isn\u2019t capturing real
          structure. This can take a while to run \u2014 it re-runs the full engine 200 times.
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="lbl" style={{ margin: 0 }}>Hypothesis to test</label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {HYPOTHESES.map((h) => (
            <button
              key={h.id}
              onClick={() => setPtHypId(h.id)}
              style={{
                padding: '6px 10px', borderRadius: 6,
                border: `1px solid ${ptHypId === h.id ? 'var(--blue)' : 'var(--border)'}`,
                background: ptHypId === h.id ? 'rgba(45,108,223,0.15)' : 'var(--surface)',
                color: ptHypId === h.id ? 'var(--blue)' : 'var(--text-muted)',
                fontSize: 11, fontWeight: ptHypId === h.id ? 600 : 400, cursor: 'pointer',
              }}
            >
              {h.id}
            </button>
          ))}
        </div>
      </div>

      <MonthPicker label="Permutation test months" selected={ptMonths} onToggle={toggle(setPtMonths)} />

      {ptError && <div className="error-box">{ptError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runPermutationTestUI} disabled={ptRunning} style={{ flex: 1, padding: '11px' }}>
          {ptRunning ? `\u23f3 ${ptLoadMsg}` : '\u25b6 Run permutation test'}
        </button>
      </div>

      {ptResults && (
        <div className="card">
          <div className="card-title">{ptHypId}</div>
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            Real expectancy: <strong>{ptResults.realMetric >= 0 ? '+' : ''}{ptResults.realMetric.toFixed(3)}R</strong>
            {' '}({ptResults.realStats.trades} trades, {ptResults.realStats.winRate}% win rate)
          </p>
          <p style={{ fontSize: 20, fontWeight: 700, marginBottom: 6,
            color: ptResults.pValue <= 0.01 ? 'var(--green)' : ptResults.pValue <= 0.05 ? 'var(--amber)' : 'var(--red)' }}>
            p = {(ptResults.pValue * 100).toFixed(1)}%
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
            {(ptResults.pValue * 100).toFixed(1)}% of {ptResults.numPermutations} permutations matched or beat the
            real result. {ptResults.pValue <= 0.01
              ? 'Under 1% — the real result clears the video\u2019s stated bar for a pass.'
              : ptResults.pValue <= 0.05
              ? 'Under 5% but above 1% — worth more scrutiny, not a clean pass.'
              : 'Above 5% — a worthless rule could plausibly have produced this result by chance. Treat the real number as unreliable.'}
          </p>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Permutation expectancy distribution: min {ptResults.permMin.toFixed(3)}R, 25th {ptResults.permP25.toFixed(3)}R,
            median {ptResults.permMedian.toFixed(3)}R, 75th {ptResults.permP75.toFixed(3)}R, max {ptResults.permMax.toFixed(3)}R
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">5. Position Sizing Comparison</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Runs the same hypothesis, on the same data, through two sizing modes: this Lab\u2019s existing
          $500-cap risk-adjusted sizing (fewer contracts on wide stops, up to 6 on tight ones) versus a fixed
          6 contracts on every trade regardless of stop distance \u2014 the rule described in the outside
          Reddit source. An earlier bottom-up review of this Lab\u2019s own H3a trade output found the
          6-contract regime specifically underperformed (it corresponds to tight, low-ATR stops); this checks
          whether that finding holds on H8 specifically.
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="lbl" style={{ margin: 0 }}>Hypothesis to test</label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {HYPOTHESES.map((h) => (
            <button
              key={h.id}
              onClick={() => setScHypId(h.id)}
              style={{
                padding: '6px 10px', borderRadius: 6,
                border: `1px solid ${scHypId === h.id ? 'var(--blue)' : 'var(--border)'}`,
                background: scHypId === h.id ? 'rgba(45,108,223,0.15)' : 'var(--surface)',
                color: scHypId === h.id ? 'var(--blue)' : 'var(--text-muted)',
                fontSize: 11, fontWeight: scHypId === h.id ? 600 : 400, cursor: 'pointer',
              }}
            >
              {h.id}
            </button>
          ))}
        </div>
      </div>

      <MonthPicker label="Sizing comparison months" selected={scMonths} onToggle={toggle(setScMonths)} />

      {scError && <div className="error-box">{scError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runSizingComparisonUI} disabled={scRunning} style={{ flex: 1, padding: '11px' }}>
          {scRunning ? `\u23f3 ${scLoadMsg}` : '\u25b6 Run sizing comparison'}
        </button>
      </div>

      {scResults && (
        <div className="card">
          <div className="card-title">{scHypId}</div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Sizing mode</th>
                <th style={{ padding: '4px 8px' }}>Trades</th>
                <th style={{ padding: '4px 8px' }}>Win%</th>
                <th style={{ padding: '4px 8px' }}>Expectancy</th>
                <th style={{ padding: '4px 8px' }}>P&amp;L</th>
                <th style={{ padding: '4px 8px' }}>Max DD</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: '4px 8px' }}>Risk-adjusted ($500 cap)</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{scResults.riskAdjusted.trades}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{scResults.riskAdjusted.winRate}%</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{scResults.riskAdjusted.expectancyR >= 0 ? '+' : ''}{scResults.riskAdjusted.expectancyR}R</td>
                <td style={{ padding: '4px 8px', textAlign: 'right', color: scResults.riskAdjusted.totalDollar > 0 ? 'var(--green)' : 'var(--red)' }}>
                  {scResults.riskAdjusted.totalDollar >= 0 ? '+' : ''}${scResults.riskAdjusted.totalDollar}
                </td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>-${scResults.riskAdjusted.maxDD}</td>
              </tr>
              <tr>
                <td style={{ padding: '4px 8px' }}>Fixed 6 contracts</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{scResults.fixed6.trades}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{scResults.fixed6.winRate}%</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{scResults.fixed6.expectancyR >= 0 ? '+' : ''}{scResults.fixed6.expectancyR}R</td>
                <td style={{ padding: '4px 8px', textAlign: 'right', color: scResults.fixed6.totalDollar > 0 ? 'var(--green)' : 'var(--red)' }}>
                  {scResults.fixed6.totalDollar >= 0 ? '+' : ''}${scResults.fixed6.totalDollar}
                </td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>-${scResults.fixed6.maxDD}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">6. Generic Pattern Miner (PIP + Clustering)</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          FINDS recurring shapes first \u2014 trading-outcome testing is secondary, not the gate. Extracts
          the geometric shape of every 24-bar close-price window (via perceptually important points) and
          groups similar shapes with a fixed 16-way k-means split, sorted by cohesion (how tightly each
          shape\u2019s real occurrences actually match each other \u2014 tighter means more consistently
          repeating, not just statistically separable). Each shape shown below includes its canonical form
          and real historical examples so you can judge for yourself whether it looks like anything, before
          any trading statistic gets attached. A trading estimate (direction, expectancy) is shown per shape
          only when there\u2019s enough forward-return data to trust one \u2014 its absence doesn\u2019t mean
          the shape isn\u2019t real, just that it hasn\u2019t been outcome-tested yet.
        </p>
      </div>

      <MonthPicker label="Pattern miner months" selected={pmMonths} onToggle={toggle(setPmMonths)} />

      {pmError && <div className="error-box">{pmError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runPatternMinerUI} disabled={pmRunning} style={{ flex: 1, padding: '11px' }}>
          {pmRunning ? `\u23f3 ${pmLoadMsg}` : '\u25b6 Run pattern miner'}
        </button>
      </div>

      {pmResults && pmResults.error && (
        <div className="error-box">{pmResults.error}</div>
      )}

      {pmResults && !pmResults.error && (
        <div className="card">
          <div className="card-title">Discovered Shapes ({pmResults.totalPatterns} patterns \u2192 {pmResults.clusters.length} shapes, sorted tightest-first)</div>

          {pmResults.clusters.map((c) => (
            <div key={c.clusterId} style={{ marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  Shape #{c.clusterId}{' '}
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}>
                    ({c.patternCount} occurrences, cohesion {c.cohesion} \u2014 lower is tighter)
                  </span>
                </div>
                {c.expectancyR != null ? (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    {c.direction} \u00b7 {c.winRate}% win [{c.winRateLower}\u2013{c.winRateUpper}] \u00b7{' '}
                    <span style={{ color: c.expectancyR >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {c.expectancyR >= 0 ? '+' : ''}{c.expectancyR}R
                    </span>
                    {' '}[{c.lower}, {c.upper}]
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>too few forward-return bars to trading-test yet</div>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3 }}>Canonical shape:</div>
              <Sparkline values={c.centroidPattern} color="var(--blue)" />
              <div style={{ fontSize: 10, color: 'var(--text-dim)', margin: '8px 0 3px' }}>Real occurrences, spread across the dataset:</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {c.examples.map((ex, i) => (
                  <Sparkline key={i} values={ex.rawWindow} color="var(--text-muted)" />
                ))}
              </div>
            </div>
          ))}

          {pmResults.pValue != null && (
            <div style={{ marginTop: 20, paddingTop: 14, borderTop: '2px solid var(--border)' }}>
              <div className="card-title" style={{ fontSize: 13 }}>
                Trading Validation \u2014 Best Shape by Expectancy (Shape #{pmResults.bestByExpectancy.clusterId})
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
                Separate from shape discovery above \u2014 this specifically checks whether the single
                best-performing shape (by expectancy, not cohesion) beats what the same greedy
                best-of-several search finds on 20 permuted (scrambled) versions of this data.
              </p>
              <p style={{ fontSize: 20, fontWeight: 700, marginBottom: 6,
                color: pmResults.pValue <= 0.01 ? 'var(--green)' : pmResults.pValue <= 0.05 ? 'var(--amber)' : 'var(--red)' }}>
                p = {(pmResults.pValue * 100).toFixed(1)}%
              </p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                {(pmResults.pValue * 100).toFixed(1)}% of {pmResults.numPermutations} full re-runs of the mining
                pipeline on scrambled data matched or beat this real result.{' '}
                {pmResults.pValue <= 0.05
                  ? 'Clears or is close to the bar \u2014 still needs Train/Validate/Test and walk-forward as its own hypothesis before trusting it further.'
                  : 'Above 5% \u2014 not statistically distinguishable from what this search finds on pure noise.'}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Permutation best-shape distribution: min {pmResults.permMin.toFixed(3)}R, median {pmResults.permMedian.toFixed(3)}R, max {pmResults.permMax.toFixed(3)}R
              </p>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">7. Combination Grid (Entry \u00d7 Sizing \u00d7 Session \u00d7 Feature)</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          6 base entry rules (H1, H2, H3a, H5, H6, H7 \u2014 ungated) \u00d7 2 sizing modes (risk-adjusted,
          fixed 6) \u00d7 5 session windows \u00d7 4 contextual gates (trend alignment, ATR floor, small wick,
          none) = 240 combinations. One click runs the real grid, then automatically re-runs the entire
          240-combination grid on 20 permuted (scrambled) versions of the same data and compares the real
          best combination against that distribution \u2014 no separate step required. Picking the single
          best of 240 is an aggressive multiple-comparisons search; this is what makes that search honest.
          Takes roughly 1\u20133 minutes \u2014 progress shown below, no need to keep clicking.
        </p>
      </div>

      <MonthPicker label="Grid months" selected={gridMonths} onToggle={toggle(setGridMonths)} />

      {gridError && <div className="error-box">{gridError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runGridUI} disabled={gridRunning} style={{ flex: 1, padding: '11px' }}>
          {gridRunning ? `\u23f3 ${gridLoadMsg}` : '\u25b6 Run full grid + validation'}
        </button>
      </div>

      {gridResults && !gridResults.best && (
        <div className="error-box">No combination produced at least 10 trades on the selected months \u2014 try a wider month range.</div>
      )}

      {gridResults && gridResults.best && (
        <div className="card">
          <div className="card-title">Best Combination</div>
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            <strong>{gridResults.best.entryId}</strong> \u00d7 {gridResults.best.sizing} \u00d7 {gridResults.best.session} \u00d7 {gridResults.best.contextual}
          </p>
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            {gridResults.best.trades} trades, {gridResults.best.winRate}% win rate, expectancy{' '}
            <strong>{gridResults.best.expectancyR >= 0 ? '+' : ''}{gridResults.best.expectancyR}R</strong>,{' '}
            P&amp;L {gridResults.best.totalDollar >= 0 ? '+' : ''}${gridResults.best.totalDollar}
          </p>

          {gridResults.pValue != null && (
            <>
              <p style={{ fontSize: 20, fontWeight: 700, marginBottom: 6,
                color: gridResults.pValue <= 0.01 ? 'var(--green)' : gridResults.pValue <= 0.05 ? 'var(--amber)' : 'var(--red)' }}>
                p = {(gridResults.pValue * 100).toFixed(1)}%
              </p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                {(gridResults.pValue * 100).toFixed(1)}% of {gridResults.numPermutations} full re-runs of the entire
                240-combination grid on scrambled data matched or beat this real best result.{' '}
                {gridResults.pValue <= 0.05
                  ? 'Clears or is close to the bar \u2014 still needs its own Train/Validate/Test and walk-forward as a standalone hypothesis before trusting it further.'
                  : 'Above 5% \u2014 picking the best of 240 finds results this good on pure noise too often for this one to be trustworthy on its own.'}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 16 }}>
                Permutation best-of-grid distribution: min {gridResults.permMin.toFixed(3)}R, median {gridResults.permMedian.toFixed(3)}R, max {gridResults.permMax.toFixed(3)}R
              </p>
            </>
          )}

          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Top 15 combinations</div>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '3px 6px' }}>Entry</th>
                <th style={{ padding: '3px 6px' }}>Sizing</th>
                <th style={{ padding: '3px 6px' }}>Session</th>
                <th style={{ padding: '3px 6px' }}>Gate</th>
                <th style={{ padding: '3px 6px' }}>n</th>
                <th style={{ padding: '3px 6px' }}>Expectancy</th>
                <th style={{ padding: '3px 6px' }}>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {gridResults.results.slice(0, 15).map((r, i) => (
                <tr key={i}>
                  <td style={{ padding: '3px 6px' }}>{r.entryId}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.sizing}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.session}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.contextual}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.trades}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.expectancyR >= 0 ? '+' : ''}{r.expectancyR}R</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: r.totalDollar > 0 ? 'var(--green)' : 'var(--red)' }}>{r.totalDollar >= 0 ? '+' : ''}${r.totalDollar}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">8. H9 Neighborhood Grid</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          A small, fixed grid anchored on H9\u2019s own structure: ATR threshold [20, 25, 30, 33.33, 40, 50,
          60] \u00d7 session scope [full Asian window, a narrower 3-hour core] \u00d7 direction [both,
          long-only, short-only] = 42 combinations. Answers whether H9 sits inside a broad region of positive
          expectancy or right at a single point that collapses the moment anything shifts. The whole
          neighborhood \u2014 not just the winner \u2014 gets automatically re-run on 100 permuted datasets
          (higher resolution than Section 7\u2019s grid, since this one is much smaller and cheaper to
          re-run). One click, no second step. Should take under a minute.
        </p>
      </div>

      <MonthPicker label="H9 grid months" selected={h9Months} onToggle={toggle(setH9Months)} />

      {h9Error && <div className="error-box">{h9Error}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runH9GridUI} disabled={h9Running} style={{ flex: 1, padding: '11px' }}>
          {h9Running ? `\u23f3 ${h9LoadMsg}` : '\u25b6 Run H9 neighborhood grid + validation'}
        </button>
      </div>

      {h9Results && !h9Results.best && (
        <div className="error-box">No combination in this neighborhood produced at least 5 trades \u2014 try a wider month range.</div>
      )}

      {h9Results && h9Results.best && (
        <div className="card">
          <div className="card-title">Best in Neighborhood</div>
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            ATR &gt; <strong>{h9Results.best.atrThreshold}</strong> \u00d7 {h9Results.best.sessionScope} \u00d7 {h9Results.best.direction}
          </p>
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            {h9Results.best.trades} trades, {h9Results.best.winRate}% win rate, expectancy{' '}
            <strong>{h9Results.best.expectancyR >= 0 ? '+' : ''}{h9Results.best.expectancyR}R</strong>,{' '}
            P&amp;L {h9Results.best.totalDollar >= 0 ? '+' : ''}${h9Results.best.totalDollar}
          </p>

          {h9Results.pValue != null && (
            <>
              <p style={{ fontSize: 20, fontWeight: 700, marginBottom: 6,
                color: h9Results.pValue <= 0.01 ? 'var(--green)' : h9Results.pValue <= 0.05 ? 'var(--amber)' : 'var(--red)' }}>
                p = {(h9Results.pValue * 100).toFixed(1)}%
              </p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                {(h9Results.pValue * 100).toFixed(1)}% of {h9Results.numPermutations} full re-runs of this
                42-combination neighborhood on scrambled data matched or beat this real best result.
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 16 }}>
                Permutation best-of-neighborhood distribution: min {h9Results.permMin.toFixed(3)}R, median {h9Results.permMedian.toFixed(3)}R, max {h9Results.permMax.toFixed(3)}R
              </p>
            </>
          )}

          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>All 42 combinations</div>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '3px 6px' }}>ATR &gt;</th>
                <th style={{ padding: '3px 6px' }}>Session</th>
                <th style={{ padding: '3px 6px' }}>Direction</th>
                <th style={{ padding: '3px 6px' }}>n</th>
                <th style={{ padding: '3px 6px' }}>Expectancy</th>
                <th style={{ padding: '3px 6px' }}>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {h9Results.results.map((r, i) => (
                <tr key={i}>
                  <td style={{ padding: '3px 6px' }}>{r.atrThreshold}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.sessionScope}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.direction}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.trades}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.expectancyR >= 0 ? '+' : ''}{r.expectancyR}R</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: r.totalDollar > 0 ? 'var(--green)' : 'var(--red)' }}>{r.totalDollar >= 0 ? '+' : ''}${r.totalDollar}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">9. Intermarket Pattern Miner (NQ vs. {INTERMARKET_SYMBOL})</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          The exact same mining engine as Section 6, pointed at a genuinely different series: the log-ratio
          spread between NQ and {INTERMARKET_SYMBOL} (is NQ outperforming or underperforming) rather
          than NQ\u2019s own price shape. This is a relationship between two instruments \u2014 something the
          two prior NQ-only mining runs could not have found no matter how thoroughly they searched.
          Shapes are found in the spread; outcomes are still measured on NQ itself, same ATR stop/target and
          friction model as everywhere else. Uses the placeholder ticker {INTERMARKET_SYMBOL} \u2014
          check the [TICKER CHECK] console log from Section 1\u2019s Train run against your real Massive
          symbol list if this fails to fetch.
        </p>
      </div>

      <MonthPicker label="Intermarket miner months" selected={imMonths} onToggle={toggle(setImMonths)} />

      {imError && <div className="error-box">{imError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runIntermarketMinerUI} disabled={imRunning} style={{ flex: 1, padding: '11px' }}>
          {imRunning ? `\u23f3 ${imLoadMsg}` : '\u25b6 Run intermarket miner'}
        </button>
      </div>

      {imResults && imResults.error && (
        <div className="error-box">{imResults.error}</div>
      )}

      {imResults && !imResults.error && (
        <div className="card">
          <div className="card-title">Discovered Spread Shapes ({imResults.alignedBars} aligned bars \u2192 {imResults.totalPatterns} patterns \u2192 {imResults.clusters.length} shapes)</div>

          {imResults.clusters.map((c) => (
            <div key={c.clusterId} style={{ marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  Spread Shape #{c.clusterId}{' '}
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}>
                    ({c.patternCount} occurrences, cohesion {c.cohesion})
                  </span>
                </div>
                {c.expectancyR != null ? (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    NQ {c.direction} \u00b7 {c.winRate}% win [{c.winRateLower}\u2013{c.winRateUpper}] \u00b7{' '}
                    <span style={{ color: c.expectancyR >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {c.expectancyR >= 0 ? '+' : ''}{c.expectancyR}R
                    </span>
                    {' '}[{c.lower}, {c.upper}]
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>too few forward-return bars to trading-test yet</div>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3 }}>Canonical spread shape:</div>
              <Sparkline values={c.centroidPattern} color="var(--blue)" />
              <div style={{ fontSize: 10, color: 'var(--text-dim)', margin: '8px 0 3px' }}>Real occurrences, spread across the dataset:</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {c.examples.map((ex, i) => (
                  <Sparkline key={i} values={ex.rawWindow} color="var(--text-muted)" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-title">10. SMC Liquidity Sweep + FVG (Dynamic Profit Hold)</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Ported faithfully from an outside strategy, including its adaptive stop-loss, dip-buy path, and
          sweep-deferral exit logic \u2014 all built from scratch here since the original indicator source
          wasn\u2019t available, each primitive tested standalone first. Uses its own dedicated simulation,
          not the shared engine, since its state (stop level, win/loss streaks) persists across trades and
          its stops are percentage-based. Sizing matches the original\u2019s stated 1% risk on a $25,000
          account, MES contracts \u2014 worth knowing that at typical S&amp;P levels this floors to
          1 contract minimum, which realizes closer to 2% risk per trade than the intended 1%.
          Its own iteration history shows several rounds of patching in direct response to observed
          backtest results \u2014 worth testing especially on months after that history ends, not just
          trusting a good number on the same window it was shaped against. Runs on {INTERMARKET_SYMBOL},
          15-minute bars, matching how it was originally built.
        </p>
      </div>

      <MonthPicker label="SMC strategy months" selected={smcMonths} onToggle={toggle(setSmcMonths)} />

      {smcError && <div className="error-box">{smcError}</div>}

      <div className="row" style={{ marginTop: 4, marginBottom: 12 }}>
        <button className="btn-green" onClick={runSmcStrategyUI} disabled={smcRunning} style={{ flex: 1, padding: '11px' }}>
          {smcRunning ? `\u23f3 ${smcLoadMsg}` : '\u25b6 Run SMC strategy'}
        </button>
      </div>

      {smcResults && (
        <div className="card">
          <div className="card-title">Results</div>
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            {smcResults.trades.length} trades, {smcResults.winRate}% win rate,{' '}
            <span style={{ color: smcResults.totalDollar >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
              {smcResults.totalDollar >= 0 ? '+' : ''}${smcResults.totalDollar.toFixed(0)}
            </span>
          </p>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
            Entries by type: {Object.entries(smcResults.byEntryType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 12 }}>
            Exits by reason: {Object.entries(smcResults.byExitReason).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}
          </div>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '3px 6px' }}>Entry type</th>
                <th style={{ padding: '3px 6px' }}>Gain%</th>
                <th style={{ padding: '3px 6px' }}>Exit reason</th>
                <th style={{ padding: '3px 6px' }}>Contracts</th>
                <th style={{ padding: '3px 6px' }}>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {smcResults.trades.slice(0, 50).map((t, i) => (
                <tr key={i}>
                  <td style={{ padding: '3px 6px' }}>{t.entryType}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{t.gainPct >= 0 ? '+' : ''}{t.gainPct.toFixed(2)}%</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{t.reason}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{t.contracts}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: t.dollarPnl > 0 ? 'var(--green)' : 'var(--red)' }}>{t.dollarPnl >= 0 ? '+' : ''}${t.dollarPnl.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {smcResults.trades.length > 50 && (
            <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>Showing first 50 of {smcResults.trades.length} trades.</p>
          )}
        </div>
      )}
    </div>
  )
}
