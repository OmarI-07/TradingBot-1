import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate,nyClock,validateCandles,prepare,summarize } from '../../src/research/engine.js';
import { priorQuantiles,trendEnvelope,createFactory,buildCandidates } from '../../src/research/hypotheses.js';
import { parseCandles } from '../../src/research/data.js';
import { dayBootstrapLower,permuteCandles,runSearch,rng } from '../../src/research/search.js';

function bars(n=80){return Array.from({length:n},(_,i)=>({time:Date.UTC(2025,0,2,14,30)+i*300000,open:100,high:101,low:99,close:100,volume:i+1}));}
const cfg={rthOnly:false,riskDollars:100,maxContracts:1,stopATR:1,targetR:1,maxHoldBars:8};
test('next-open entry; same-entry-bar barriers checked; every signal bar consumed',()=>{
  const c=bars(),visited=[];c[20].close=100.75;c[21]={...c[21],open:105,high:110,low:100,close:106};
  const r=simulate(c,i=>{visited.push(i);return i===20?1:0;},cfg);
  assert.equal(visited.length,c.length);assert.equal(r.trades.length,1);
  assert.equal(r.trades[0].entryIdx,21);assert.equal(r.trades[0].entryPrice,105.25);
  assert.equal(r.trades[0].reason,'stop');assert.equal(r.trades[0].exitIdx,21);
});
test('net R includes commission and slips',()=>{
  const c=bars();c[22]={...c[22],low:96,high:101};
  const t=simulate(c,i=>i===20?1:0,cfg).trades[0];
  assert.equal(t.commission,1.48);assert.equal(t.dollarPnl,t.grossPnl-t.commission);
  assert.equal(t.rMult,t.dollarPnl/t.riskDollars);assert.ok(t.rMult<-1);
});
test('risk cap can reject every contract instead of forcing one',()=>{
  const r=simulate(bars(),i=>i===20?1:0,{...cfg,riskDollars:1});
  assert.equal(r.trades.length,0);assert.equal(r.rejectedRisk,1);
});
test('sizing includes planned stop slip and commissions',()=>{
  const r=simulate(bars(),i=>i===20?1:0,{...cfg,riskDollars:100,maxContracts:100});
  assert.ok(r.trades[0].plannedWorstLoss<=100);
});
test('gap through stop fills from open, not stale stop price',()=>{
  const c=bars();c[22]={...c[22],open:90,high:91,low:89,close:90};
  const t=simulate(c,i=>i===20?1:0,cfg).trades[0];
  assert.equal(t.reason,'gap-stop');assert.equal(t.exitPrice,89.5);
});
test('short gaps also receive adverse fill',()=>{
  const c=bars();c[22]={...c[22],open:110,high:111,low:109,close:110};
  const t=simulate(c,i=>i===20?-1:0,cfg).trades[0];
  assert.equal(t.reason,'gap-stop');assert.equal(t.exitPrice,110.5);
});
test('pending signal exits fill at next open before later intrabar stop',()=>{
  const c=bars();c[23]={...c[23],open:100,high:110,low:90,close:100};
  const t=simulate(c,i=>({direction:i===20?1:0,exit:i===22}),cfg).trades[0];
  assert.equal(t.reason,'signal');assert.equal(t.exitPrice,99.75);
});
test('time and sample-end positions are realized',()=>{
  const t=simulate(bars(),i=>i===20?1:0,cfg).trades[0];assert.equal(t.reason,'time');
  const end=simulate(bars(23),i=>i===20?1:0,cfg).trades[0];assert.equal(end.reason,'sample-end');
});
test('cancel pending entry across data gap',()=>{
  const c=bars();for(let i=21;i<c.length;i++)c[i].time+=3600000;
  assert.equal(simulate(c,i=>i===20?1:0,cfg).trades.length,0);
});
test('New York clock follows DST',()=>{
  assert.equal(nyClock(Date.parse('2025-01-02T14:30:00Z')).minute,570);
  assert.equal(nyClock(Date.parse('2025-07-02T13:30:00Z')).minute,570);
});
test('invalid, duplicate and wrong-interval data rejected',()=>{
  let c=bars();c[2].time=c[1].time;assert.throws(()=>validateCandles(c),/Duplicate/);
  c=bars();c[2].high=90;assert.throws(()=>validateCandles(c),/Invalid/);
  c=bars().map((x,i)=>({...x,time:x.time+i*600000}));assert.throws(()=>validateCandles(c),/adjacent/);
});
test('CSV parsing handles timezone and seconds; rejects trade CSV',()=>{
  const c=parseCandles('time,open,high,low,close,volume\n1735828200,100,101,99,100,9');assert.equal(c[0].time,1735828200000);
  assert.throws(()=>parseCandles('time,open,high,low,close\n2025-01-01 09:30,1,2,1,2'),/timezone/);
  assert.throws(()=>parseCandles('entryTime,exitTime,dollarPnl\n1,2,3'),/Candle CSV/);
});
test('rolling quantiles exclude current and future bars',()=>{
  const q=priorQuantiles([1,2,3,1000,5],3,0,1);
  assert.equal(q.highs[3],3);assert.equal(q.highs[4],1000);
});
test('trendline fit excludes breakout candle',()=>{
  const c=bars();const before=trendEnvelope(c,40,36);c[40].close=1e8;
  assert.deepEqual(trendEnvelope(c,40,36),before);
});
test('candidate grid has stable unique IDs and covers six families',()=>{
  const c=buildCandidates();assert.equal(c.length,180);assert.equal(new Set(c.map(x=>x.id)).size,c.length);
  assert.equal(new Set(c.map(x=>x.family)).size,6);
});
test('features and signals do not change when future candles change',()=>{
  const c=bars(400).map((x,i)=>({...x,open:100+Math.sin(i/7),high:102+Math.sin(i/7),low:98+Math.sin(i/7),close:100+Math.sin(i/7)}));
  const future=c.map((x,i)=>i>300?{...x,open:x.open+100,high:x.high+100,low:x.low+100,close:x.close+100}:x);
  const a=createFactory(c,200),b=createFactory(future,200);
  assert.deepEqual(a.models,b.models);
  for(const candidate of buildCandidates().filter((_,i)=>i%7===0)){
    const sa=a.signal(candidate),sb=b.signal(candidate);
    for(let i=0;i<=300;i++)assert.deepEqual(sa(i),sb(i),candidate.id);
  }
});
test('permutations preserve timestamps, valid candles, paired volume, total log return',()=>{
  const c=bars(400).map((x,i)=>({...x,open:100+i*.01,high:102+i*.01,low:98+i*.01,close:100+i*.01+Math.sin(i)*.2}));
  const p=permuteCandles(c,prepare(c).clock,88);validateCandles(p);
  assert.deepEqual(p.map(x=>x.time),c.map(x=>x.time));
  assert.deepEqual(p.map(x=>x.volume).sort((a,b)=>a-b),c.map(x=>x.volume).sort((a,b)=>a-b));
  assert.ok(Math.abs(p.at(-1).close-c.at(-1).close)<1e-8);
});
test('day-block bootstrap deterministic and positive for uniformly positive days',()=>{
  const t=[{day:'a',rMult:.5},{day:'b',rMult:.3}];
  const low=dayBootstrapLower(t,['a','b','c'],100,.05,41);
  assert.equal(low,dayBootstrapLower(t,['a','b','c'],100,.05,41));assert.ok(low>=0);
});

export function syntheticDays(days=30){
  const out=[];let price=20000;
  for(let day=0;day<days;day++)for(let j=0;j<78;j++){
    const open=price;price+=j<6?1:3;
    out.push({time:Date.UTC(2025,0,2+day,14,30)+j*300000,open,high:price+1,low:open-1,close:price,volume:100+j});
  }
  return out;
}
const searchOptions={execution:{...cfg,riskDollars:100},search:{minDays:20,minTrainTrades:1,minValidationTrades:1,minTestTrades:1,
  minWinRate:0,minExpectancyR:0,minTradesPerDay:0,minActiveDayFraction:0,minProfitableMonthFraction:0,
  maxDrawdownR:100,bootstrapReps:50,stressCostMultiplier:1}};
test('search freezes finalists, resumes deterministically and never forces three',async()=>{
  const c=syntheticDays();let checkpoint,holdouts=0;
  const r=await runSearch(c,searchOptions,{onCheckpoint:s=>{checkpoint=structuredClone(s);},onHoldoutOpen:()=>{holdouts++;}});
  assert.equal(r.testedCandidates,180);assert.ok(r.accepted.length<=3);assert.ok(holdouts<=1);
  assert.deepEqual(r.finalists.map(x=>x.candidate.id),checkpoint.finalists);
  const resumed=await runSearch(c,searchOptions,{checkpoint});assert.deepEqual(resumed,r);
  await assert.rejects(runSearch(c,{...searchOptions,search:{...searchOptions.search,seed:123}},{checkpoint}),/Checkpoint/);
});
test('pausing saves completed work and resumable search finishes',async()=>{
  let checkpoint;await assert.rejects(runSearch(syntheticDays(),searchOptions,{
    onCheckpoint:s=>{checkpoint=structuredClone(s);},shouldStop:()=>checkpoint?.rows.length>=2,
  }),/PAUSED/);
  assert.equal(checkpoint.rows.length,2);
  const result=await runSearch(syntheticDays(),searchOptions,{checkpoint});assert.equal(result.testedCandidates,180);
});
test('changing only test prices cannot change training, validation, or finalist selection',async()=>{
  const c=syntheticDays(),other=c.map((x,i)=>i>=24*78?{...x,open:x.open+1000,high:x.high+1000,low:x.low+1000,close:x.close+1000}:x);
  const a=await runSearch(c,searchOptions),b=await runSearch(other,searchOptions);
  assert.deepEqual(a.training,b.training);assert.deepEqual(a.validation,b.validation);
  assert.deepEqual(a.finalists.map(x=>x.candidate.id),b.finalists.map(x=>x.candidate.id));
});
test('selection-aware MCPT runs full grid and corrected p-value is never zero',async()=>{
  const r=await runSearch(syntheticDays(20),{...searchOptions,search:{...searchOptions.search,permutations:1}});
  assert.equal(r.mcpt.permutations,1);assert.ok(r.mcpt.pValue>=.5);
});
test('high win rate with large losses is not positive expectancy',()=>{
  const trades=Array.from({length:10},(_,i)=>({day:'2025-01-02',dollarPnl:i===9?-20:1,rMult:i===9?-20:1,commission:0}));
  const stats=summarize(trades,1);assert.equal(stats.winRate,.9);assert.ok(stats.totalDollar<0);assert.ok(stats.expectancyR<0);
});
test('default search can exhaust noisy synthetic data without inventing three patterns',async()=>{
  const random=rng(217),c=syntheticDays(120);let price=20000;
  for(const bar of c){const open=price;price+=(random()-.5)*8;Object.assign(bar,{open,close:price,high:Math.max(open,price)+random()*2,low:Math.min(open,price)-random()*2});}
  const report=await runSearch(c);assert.equal(report.status,'EXHAUSTED');assert.ok(report.accepted.length<3);
});
test('holdout lock failure prevents test execution',async()=>{
  let checkpoint;await assert.rejects(runSearch(syntheticDays(),searchOptions,{
    onCheckpoint:s=>{checkpoint=structuredClone(s);},onHoldoutOpen:()=>{throw new Error('holdout already exposed');},
  }),/holdout already exposed/);
  assert.ok(checkpoint.finalists.length>0);assert.equal(checkpoint.test.length,0);
});
