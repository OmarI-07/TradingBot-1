// Standalone research execution. Bar timestamps are UTC milliseconds at bar OPEN.
export const ENGINE_VERSION = 'nq-research-2';
export const DEFAULT_EXECUTION = Object.freeze({
  pointValue: 2, tickSize: 0.25, commissionPerSide: 0.74,
  entrySlipTicks: 1, stopSlipTicks: 2, exitSlipTicks: 1,
  riskDollars: 100, maxContracts: 6, stopATR: 1.5, targetR: 1.5,
  maxHoldBars: 24, cooldownBars: 3, intervalMs: 300000,
  rthOnly: true, flattenMinute: 955, // 15:55 New York; research assumption, not firm rules
});
const nyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function nyClock(time) {
  const p = Object.fromEntries(nyFormatter.formatToParts(time).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: +p.hour * 60 + +p.minute };
}
export function validateCandles(candles, intervalMs = 300000) {
  if (!Array.isArray(candles) || candles.length < 30) throw new Error('At least 30 candles required.');
  let gaps = 0, regular = 0;
  candles.forEach((c, i) => {
    if (![c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) || c.time < 1e12 ||
      Math.min(c.open, c.high, c.low, c.close) <= 0 || c.high < Math.max(c.open, c.close, c.low) ||
      c.low > Math.min(c.open, c.close) || (c.volume != null && (!Number.isFinite(c.volume) || c.volume < 0)))
      throw new Error(`Invalid candle ${i}; use positive OHLC and UTC epoch milliseconds.`);
    if (i && c.time <= candles[i-1].time) throw new Error(`Duplicate or unsorted timestamp at ${i}.`);
    if (i && c.time - candles[i-1].time < intervalMs) throw new Error(`Bars must be ${intervalMs / 60000} minutes, not a smaller interval.`);
    if (i && (c.time - candles[i-1].time) % intervalMs !== 0) throw new Error(`Irregular interval at ${i}.`);
    if (i && c.time - candles[i-1].time > intervalMs) gaps++;
    if (i && c.time - candles[i-1].time === intervalMs) regular++;
  });
  if (!regular) throw new Error('No adjacent bars match the required interval. Supply 5-minute candles.');
  return { bars: candles.length, gaps, warning: 'Contract roll correctness and completeness require source verification.' };
}
export function atrSeries(candles, period = 14) {
  const result = Array(candles.length).fill(NaN), tr = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], prev = i ? candles[i-1].close : c.open;
    tr[i] = Math.max(c.high-c.low, Math.abs(c.high-prev), Math.abs(c.low-prev));
    sum += tr[i]; if (i >= period) sum -= tr[i-period];
    if (i >= period-1) result[i] = sum/period;
  }
  return result;
}
export function prepare(candles) {
  return { candles, atr: atrSeries(candles), clock: candles.map(c => nyClock(c.time)) };
}
const tickUp = (v, t) => Math.ceil((v - 1e-9)/t)*t;
const tickDown = (v, t) => Math.floor((v + 1e-9)/t)*t;
function marketFill(price, buy, ticks, t) {
  return buy ? tickUp(price, t) + ticks*t : tickDown(price, t) - ticks*t;
}
export function executionConfig(input = {}) {
  const c = { ...DEFAULT_EXECUTION, ...input };
  for (const k of ['pointValue','tickSize','riskDollars','maxContracts','stopATR','targetR','maxHoldBars','intervalMs'])
    if (!Number.isFinite(c[k]) || c[k] <= 0) throw new Error(`Invalid ${k}`);
  for (const k of ['commissionPerSide','entrySlipTicks','stopSlipTicks','exitSlipTicks','cooldownBars'])
    if (!Number.isFinite(c[k]) || c[k] < 0) throw new Error(`Invalid ${k}`);
  return c;
}
// signal(i) runs on EVERY closed candle, including warmup/cooldown/in-position.
// Returns direction -1/0/+1, or {direction, exit}. Orders execute next bar open.
export function simulate(candles, signal, input = {}, range = {}, prepared = null) {
  const cfg = executionConfig(input), data = prepared || prepare(candles);
  const start = range.start ?? 20, end = range.end ?? candles.length;
  const trades = []; let pos = null, pending = null, lastExit = -Infinity;
  let realized = 0, peak = 0, maxDrawdown = 0, rejectedRisk = 0;
  const mark = value => { peak = Math.max(peak, value); maxDrawdown = Math.max(maxDrawdown, peak-value); };
  function close(i, raw, reason, ticks = cfg.exitSlipTicks) {
    const c = candles[i];
    const fill = marketFill(raw, pos.direction < 0, ticks, cfg.tickSize);
    const grossPnl = pos.direction*(fill-pos.entryPrice)*cfg.pointValue*pos.contracts;
    const commission = 2*cfg.commissionPerSide*pos.contracts;
    const dollarPnl = grossPnl-commission;
    realized += dollarPnl; mark(realized);
    trades.push({ ...pos, exitIdx: i, exitPrice: fill, exitTime: c.time, reason,
      side: pos.direction > 0 ? 'long' : 'short', time: pos.entryTime,
      grossPnl, commission, dollarPnl, rMult: dollarPnl/pos.riskDollars, barsHeld: i-pos.entryIdx,
      session: 'New York', day: data.clock[pos.entryIdx].day });
    pos = null; pending = null; lastExit = i;
  }
  for (let i = 0; i < end; i++) {
    const c = candles[i], clock = data.clock[i];
    const canEnter = !cfg.rthOnly || (clock.minute >= 575 && clock.minute < cfg.flattenMinute-5);
    if (i >= start && pending && !pos) {
      if (i === pending.i+1 && c.time-candles[i-1].time === cfg.intervalMs && canEnter) {
        const direction = pending.direction;
        const entryPrice = marketFill(c.open, direction > 0, cfg.entrySlipTicks, cfg.tickSize);
        const dist = tickUp(pending.atr*cfg.stopATR, cfg.tickSize);
        const unitWorstRisk = (dist + cfg.stopSlipTicks*cfg.tickSize)*cfg.pointValue + 2*cfg.commissionPerSide;
        const contracts = Math.min(Math.floor(cfg.maxContracts), Math.floor(cfg.riskDollars/unitWorstRisk));
        if (contracts >= 1 && dist > 0) {
          pos = { direction, entryIdx: i, entryTime: c.time, entryPrice, contracts,
            stopPrice: entryPrice-direction*dist,
            targetPrice: direction > 0 ? tickUp(entryPrice+dist*cfg.targetR,cfg.tickSize) : tickDown(entryPrice-dist*cfg.targetR,cfg.tickSize),
            riskDollars: dist*cfg.pointValue*contracts, plannedWorstLoss: unitWorstRisk*contracts,
            stopDistance: dist };
        } else rejectedRisk++;
      }
      pending = null;
    }
    if (pos) {
      const long = pos.direction > 0;
      const gapStop = long ? c.open <= pos.stopPrice : c.open >= pos.stopPrice;
      const gapTarget = long ? c.open >= pos.targetPrice : c.open <= pos.targetPrice;
      const stop = long ? c.low <= pos.stopPrice : c.high >= pos.stopPrice;
      const target = long ? c.high >= pos.targetPrice : c.low <= pos.targetPrice;
      // Drawdown approximation: favorable-then-adverse ordering is conservative
      // when OHLC does not reveal the true sequence. Bound excursion by exits.
      const favorable = gapStop ? c.open : long ? Math.min(c.high,pos.targetPrice) : Math.max(c.low,pos.targetPrice);
      const adverse = gapStop ? c.open : long ? Math.max(c.low,pos.stopPrice) : Math.min(c.high,pos.stopPrice);
      const liquidation = price => realized + pos.direction*(price-pos.entryPrice)*cfg.pointValue*pos.contracts - 2*cfg.commissionPerSide*pos.contracts;
      if (pos.exitPending && !gapStop && !gapTarget) mark(liquidation(c.open));
      else {
        if (!gapStop && !gapTarget) mark(liquidation(favorable));
        if (!gapTarget) mark(liquidation(adverse));
      }
      if (gapStop) close(i,c.open,'gap-stop',cfg.stopSlipTicks);
      else if (gapTarget) close(i,pos.targetPrice,'target');
      else if (pos.exitPending) close(i,c.open,'signal');
      else if (stop) close(i,pos.stopPrice,'stop',cfg.stopSlipTicks); // both touched: stop first
      else if (target) close(i,pos.targetPrice,'target');
      else if (i-pos.entryIdx >= cfg.maxHoldBars) close(i,c.close,'time');
      else if (cfg.rthOnly && clock.minute+cfg.intervalMs/60000 >= cfg.flattenMinute) close(i,c.close,'session');
    }
    const raw = signal(i);
    const action = typeof raw === 'number' ? { direction: raw } : (raw || { direction: 0 });
    if (pos && action.exit) pos.exitPending = true;
    if (i >= start && !pos && i-lastExit >= cfg.cooldownBars && [-1,1].includes(action.direction) && Number.isFinite(data.atr[i]))
      pending = { direction: action.direction, atr: data.atr[i], i };
  }
  if (pos && end) close(end-1,candles[end-1].close,'sample-end');
  return { trades, maxDrawdown, rejectedRisk, stats: summarize(trades),
    drawdownMethod: 'Conservative OHLC mark-to-market approximation; not an exact funded-account simulation.' };
}
export function summarize(trades, totalDays = 0) {
  const wins = trades.filter(t => t.dollarPnl > 0), losses = trades.filter(t => t.dollarPnl < 0);
  const net = trades.reduce((s,t) => s+t.dollarPnl,0), grossWin = wins.reduce((s,t) => s+t.dollarPnl,0);
  const grossLoss = -losses.reduce((s,t) => s+t.dollarPnl,0);
  const months = {}, days = new Set(); let equity=0, peak=0, maxDD=0, streak=0, maxLossStreak=0;
  for (const t of trades) {
    const day=t.day || nyClock(t.time).day; days.add(day);
    months[day.slice(0,7)] = (months[day.slice(0,7)] || 0)+t.dollarPnl;
    equity+=t.dollarPnl; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity);
    streak = t.dollarPnl <= 0 ? streak+1 : 0; maxLossStreak=Math.max(streak,maxLossStreak);
  }
  return { trades: trades.length, winRate: trades.length ? wins.length/trades.length : 0,
    expectancyR: trades.length ? trades.reduce((s,t)=>s+t.rMult,0)/trades.length : 0,
    totalDollar: net, profitFactor: grossLoss ? grossWin/grossLoss : grossWin ? null : 0,
    activeDays: days.size, tradesPerDay: totalDays ? trades.length/totalDays : 0,
    activeDayFraction: totalDays ? days.size/totalDays : 0, maxDD, maxLossStreak, months,
    totalCommission: trades.reduce((s,t)=>s+t.commission,0) };
}
