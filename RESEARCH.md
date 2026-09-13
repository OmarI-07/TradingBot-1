# Retest v2 rebuild (September 12, 2026)

The browser defaults to Retest v2 and Development mode. The CLI config does the same.
Development evaluates training and validation only: final test simulation and holdout-lock callbacks do not run.
Reports distinguish evaluated candidates from candidates that passed validation.
Old checkpoints are incompatible with engine version nq-research-2; preserve them as research history.

## Registered experiment

14 candidates: 72/144-bar prior high/low breakout, up to six bars to retest and reclaim,
1R target, existing ATR stop and 24-bar maximum hold. Each lookback has a baseline
and six separate filters (no combinations or automated tuning):

- Morning: breakout and reclaim before 11:30 New York.
- Strong close: reclaim closes in the directional outer 25% of its candle.
- Trend: prior 36-close regression slope agrees with breakout direction.
- Compression: prior 12-bar range is at most half the preceding 24-bar range.
- Volume: breakout volume is at least 1.5 times the previous 20-bar mean; missing/zero history rejects it.
- Opening range: complete six-bar 09:30�10:00 range and breakout close beyond its directional boundary.

All variants arm only during RTH, clear pending setups across missing bars or dates,
and signal at reclaim close for the existing next-open execution engine. Baselines
therefore intentionally differ from the old retest's overnight setup behavior.
Volume compares adjacent bars, not a seasonally adjusted time-of-day volume baseline.
All variants belong to one family: only two train-selected variants reach validation,
and at most one becomes a frozen finalist. They cannot satisfy a target of three independent patterns.

## Run once

```powershell
npm run test:research
node research/run.mjs --data "C:\path\to\nq-candles.json" --out research-runs/retest-v2-development --config research/config.json
```

In HypothesisLab choose Retest v2 and Development: holdout closed, load the same candle
file, then Start registered search. Keep execution/risk settings consistent with the
previous experiment if comparing results (the shipped risk default is $100; the user's
earlier report used $200). Export the report after completion.

The earlier validation period informed these new hypotheses, so it is now development
history, even if a revised strategy passes. Freeze the research specification before
using untouched dates. Explicit `search.mode: "confirmatory"` enables the final test;
it is not a certification of significance. MCPT remains optional and unchanged.
Do not repeatedly alter thresholds to obtain passes. The original 180-candidate suite
remains available as `search.suite: "legacy"`. Watch mode rejects development mode;
use a single run while researching this rebuild.

No real candle dataset accompanied this rebuild; downloaded reports alone cannot
reproduce trades. Performance is unmeasured until a candle dataset is run.

---

The following is the original v1 documentation; the defaults and workflow above supersede it.

# NQ Pattern Research

This update adds a research search to the existing Hypothesis Lab and a dependency-free Node runner. It is based on your repository snapshot `d271a22`. The research module does not place orders or publish strategies to the live bot.

**There are no demonstrated NQ winners in this delivery.** Execution and research logic were tested with synthetic candles. Supply real historical candles to evaluate the hypotheses.

## Quick start: your existing app

1. Copy the changed/new files from this update into your checkout, or extract the full source ZIP into a new directory. Keep your current `.env` private and supply the same configuration to the new checkout if needed.
2. Run `npm install` and `npm run dev` in that directory.
3. Open **Hypothesis Lab**. The new **Pattern Research** panel appears above the original experiments.
4. Load a 5-minute NQ candle CSV/JSON, or select consecutive months using the existing Massive connection. Start with at least 120 trading days; a substantially longer history is preferable. Confirm the last 20% has never informed your strategy choices.
5. Choose MNQ or NQ execution, your risk budget, desired minimum win rate, and minimum trades/day. Check the commission/slippage assumptions against your actual fees. For other settings use the Node runner and config file.
6. Click **Start registered search**. It evaluates 180 candidates and reports progress. **Pause** stops at a checkpoint. **Resume same experiment** uses saved settings and requires the identical candles. It does not silently restart with new settings.
7. Download the full report and each frozen finalist's trades. A failed test finalist is reported as failed; the program does not try replacements against the same holdout.

Browser runs require the tab to remain open. Progress is saved to localStorage when space permits. Export the checkpoint for backup. For very large histories or many permutations use Node.

## Long runs in Node (no npm dependencies required)

Requires Node.js 20 or later. From the repository directory:

```sh
node research/run.mjs --data path/to/nq-5m.csv --out research-runs/first --config research/config.json
```

Repeat the entire registered training search on 199 randomized data sets:

```sh
node research/run.mjs --data path/to/nq-5m.csv --out research-runs/first-mcpt --config research/config.json --permutations 199
```

**Choose whether to include MCPT before the first test exposure.** Changing settings later and reusing the same holdout is deliberately blocked. Start a new experiment with genuinely fresh final test dates instead.

Press Ctrl+C once to pause. Rerun the identical command to resume. Each candidate and completed permutation saves a checkpoint. Work interrupted inside a permutation is repeated for that one permutation. The runner produces:

- `checkpoint.json`: resumable state, settings, frozen candidate IDs and progress.
- `report.json`: training scores, validation failures, test finalists, pass/fail reasons, assumptions and limitations.
- `finalist-N-trades.csv`: the final test trade log, whether the finalist passed or failed.

Research runs terminate after exhausting the registered search or testing the frozen finalists. The target is three qualifying patterns, but zero, one or two is a valid outcome. The program does not lower thresholds, endlessly expand the search, or keep opening the holdout until three winners appear. More repetitions of the same history are not new market evidence.

### Optional persistent watch mode

```sh
node research/watch.mjs --data path/to/nq-5m.csv --out research-runs/watch --config research/config.json --poll 60
```

This process stays alive until a run finds three candidates that pass the gates, or you press Ctrl+C. It checks the input file every 60 seconds. An external collector must append completed candles; the watcher does not obtain market data itself. It skips unchanged data, saves progress, and waits after an exhausted search. If it previously opened a final test, the next experiment's final test must start strictly after that prior test ended. With the 60/20/20 split, this can require a substantial amount of additional history. A pause during final testing can resume the same unchanged input and frozen experiment.

The input must remain append-only relative to completed runs. Do not use an auto-adjusting historical file that silently rewrites earlier candles. The watcher can wait indefinitely if qualifying patterns never exist or no new data arrives. It never manufactures three winners to terminate. Watch-mode statistical tests apply per registered experiment; repeated experiments over time are not a lifetime familywise significance guarantee. Use prospective paper validation for any selected pattern.

## Candle format

```csv
time,open,high,low,close,volume
2025-01-02T14:30:00Z,21000,21006,20996,21003,1200
2025-01-02T14:35:00Z,21003,21008,21001,21005,950
```

This is a format example, not real market data. The CSV reader accepts UTC milliseconds, Unix seconds, or ISO timestamps with an explicit timezone. Timestamps must identify **bar open**. JSON accepts an array, `{ "candles": [...] }`, or `{ "bars": [...] }`, using numeric UTC milliseconds. OHLC fields must be numeric, valid, positive, ascending by time, with no duplicates. Trade export CSVs cannot reconstruct candles and are rejected.

Provide consecutive 5-minute history. Exported Massive candle JSON is supported. Contract selection, volume, rollover dates, and completeness need independent verification: the original `massiveFinance.js` provider code is preserved, not certified or repaired in this update. Do not concatenate overlapping contracts or silently carry artificial contract-roll jumps into a test. NQ candle prices with MNQ execution costs are an approximation to micro fills; use appropriate costs and forward validation.

## What is tested

| Family | Candidates | Definition |
| --- | ---: | --- |
| Trendline | 18 | Fit an OLS slope to preceding closes; move parallel boundaries to enclose them; test a close beyond the projected envelope, with a small ATR buffer. Windows 36/72/144 bars. |
| Volatility expansion | 18 | Exponentially accumulate ATR-normalized bar range; detect a transition from below the prior rolling 10th percentile to above the 90th; use price movement since the quiet observation for direction. Test fixed exits and an additional quiet-volatility exit. |
| Breakout retest | 18 | Break a preceding high/low channel, then touch and reclaim the frozen breakout level within 3 or 6 bars. |
| Opening range | 12 | Build 09:30–09:45 or 09:30–10:00 New York range, then take its first buffered close breakout before noon. Requires the expected opening-range bar count. |
| Learned price motif | 108 | Represent the preceding 12 or 24 bars by three segment changes divided by ATR. Fit tercile boundaries on TRAIN, form 27 categorical shapes, and evaluate each long/short direction. |
| Donchian baseline | 6 | A simple preceding-window high/low breakout for comparison with more complex rules. |

The motif search is an interpretable quantized shape learner. It is **not** the author's PIP clustering implementation or a neural network. Trendline fitting is an original simpler OLS-envelope baseline, not an exact reproduction of his optimizer. Hawkes-inspired smoothing is an exponentially decaying volatility accumulator, not an estimated point-process Hawkes model. Its thresholds and timing differ from the linked example. The new engine's stops/time/session exits remain active in the quiet-exit variant; it is not an exact replication of the source strategy's native exits.

Windows, thresholds and exit choices are registered before evaluation. All variants are counted. Candidate target distances are 1R, 1.5R or 2R according to the grid, with 1.5 ATR protective stops and a 24-bar time stop. Higher win rate is a requirement to test, not a promise.

## Execution model

- Features consume every closed candle. Orders from that candle fill at the **next adjacent candle open**, with adverse slippage.
- New pending entries are cancelled across missing bars or session gaps. Open positions use gap-aware stops at the next available open; a gap can exceed the planned budget.
- Stops and targets are checked on the entry candle too. When both are touched and the open does not resolve ordering, the stop is assumed first.
- Prices round to contract ticks. Sizing reserves normal modeled stop slippage and both commissions. If one contract exceeds the budget, skip the trade.
- The default assumes **MNQ**, $2/point, $100 risk budget, at most six contracts, $0.74 commission per side, one tick of entry/exit slippage, and two ticks at stops. These are configurable research assumptions.
- Default new-panel entries are during New York regular hours, after 09:35 and before 15:50. Positions flatten on the bar ending at 15:55. DST is handled by `America/New_York`. This is not a representation of any particular prop firm's policy.
- If a position remains open at a sample boundary, it is liquidated and counted. Commission-adjusted dollar P&L divided by initial stop risk is **net R**.
- Drawdown includes a conservative OHLC mark-to-market approximation. OHLC does not establish the true favorable/adverse price ordering. This is not a tick-accurate trailing-drawdown account simulator.

## Acceptance process

1. Split by chronological New York dates: 60% training, 20% validation, 20% final test. Motif boundaries use training only. Each later segment gets an entry embargo of maximum holding period + cooldown + one bar; earlier history remains usable for feature warmup.
2. Screen all 180 training candidates. Defaults: at least 80 trades, 50% wins, +0.03 net R/trade, positive total net dollars, 0.5 trades/day, activity on at least 25% of days, positive net P&L in at least half of represented calendar months, and approximate drawdown at most 20 times the per-trade dollar budget.
3. Rank training survivors by mean net R times square root of trade count. Validate at most 12 candidates, at most two per family.
4. Validation requires at least 40 trades and the other gates, a positive day-block bootstrap lower bound, and positive expectancy with doubled commissions and slippage. The bootstrap uses 2,000 replications and a one-sided alpha of 0.05 divided by the actual shortlist size.
5. If enabled, MCPT repeats **all 180 training candidates**, including motif fitting, on each permutation. It compares the best training ranking metric against randomized best scores using `(1 + exceedances) / (1 + permutations)`. A p-value above 0.05 prevents opening the final test. This controls only the registered search under this chosen null model, not the researcher's entire prior experiment history.
6. Freeze up to three candidates from different families, ranked by their validation lower bound. Open the final test once. Require at least 40 final-test trades, the same economics/frequency gates, cost stress, and a positive bootstrap bound with alpha divided by the number of finalists.
7. Save pass/fail results without replacing failed finalists. A historical pass still requires prospective paper trading and firm-specific risk evaluation.

Calendar months with no trades count as nonprofitable months. All observed regular-session dates count in frequency denominators, including zero-trade dates. Fractional-month windows and short histories reduce the strength of these checks. The default gates are research choices, not mathematically guaranteed definitions of an edge.

## Statistical and operational limits

- A one-sided bootstrap bound is an approximate resampling diagnostic. Entire trading days are sampled together to retain within-day clustering; dependence across days is not modeled. Small samples remain unreliable.
- Permutation sampling moves bar shapes and volume together within New York minute-of-day groups, while leaving gap ratios at their original times. It retains some intraday seasonality but destroys other dependence. Changing that null model can change the result.
- Three strategy families can have highly correlated returns. This update does not claim portfolio diversification or account passing probability.
- Browser holdout locks persist in that browser; Node locks persist in `research-runs/holdout-locks`. They are experiment hygiene, not tamperproof controls. Clearing storage, editing datasets, using a new checkout or switching browser/CLI can bypass them. Maintain an external record of every date already inspected.
- A learned filter is not automatically a source of edge. Repeatedly changing features, costs, windows, or thresholds after seeing results makes those dates development data.
- No broker, order router, paid data download, deployment, or live strategy publication is performed by the Node runner. The UI data loader uses your existing configured provider only when you click it.

## Changes to the original Hypothesis Lab

- Added the new research panel above the original UI.
- Routed legacy experiments through the shared execution engine so state updates continue during open positions and cooldowns, entries use next opens, costs affect R, unaffordable trades are skipped, and sample-end trades are realized.
- Used the same execution logic for individual Context Explorer outcomes, including time exits; events with no executable next bar or insufficient risk budget still have no trade outcome.
- Corrected the original ORB's opening window to 09:30–10:00 New York time.
- Applied the +1 correction to the old fixed-hypothesis permutation p-value and retained volume on shuffled bars. That old test still does not repeat model selection; use the new MCPT for the registered grid.
- Relabeled the old month-by-month tests so previously inspected months are not automatically described as out-of-sample. Older session buckets and exploratory confidence intervals remain clearly limited.

**Old backtest numbers are no longer comparable without rerunning.** The rest of the live/paper pipeline is preserved and has not received these research-engine fixes.

## Validation performed

Run the reproducible research tests:

```sh
npm run test:research
```

The 25-test suite checks next-bar timing, same-bar exits, gap fills, commission-adjusted R, budget rejection, DST, malformed data, feature causality, quantile timing, motif fitting, deterministic resampling, checkpoint/resume, final-test isolation, selection-aware permutation execution, rejection of a reused holdout, and exhaustion on a seeded noisy synthetic data set without inventing three winners. The CLI was also run and resumed on synthetic data. All 14 original legacy hypothesis functions were exercised on synthetic candles, including shared Context Explorer time-exit/net-R parity.

All 45 JS/JSX source files compiled using a locally available Babel compiler. **The full Vite production build and interactive browser behavior were not verified**: dependencies installed successfully, but esbuild was blocked by sandbox access restrictions while resolving the Vite configuration through ancestor directories. Run `npm install` then `npm run build` in your normal environment before deployment. No real NQ performance run has been performed.

## Research references

These sources informed the design; their historical examples do not establish NQ profitability. New research modules here are original implementations, not copied versions of their Python files.

- https://github.com/neurotrader888/TrendLineAutomation
- https://github.com/neurotrader888/market-structure
- https://github.com/neurotrader888/TrendlineBreakoutMetaLabel
- https://github.com/neurotrader888/VolatilityHawkes
- https://github.com/neurotrader888/TechnicalAnalysisAutomation
- https://github.com/neurotrader888/mcpt
