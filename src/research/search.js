import { ENGINE_VERSION, executionConfig, validateCandles, prepare, simulate, summarize } from './engine.js';
import { buildCandidates, createFactory, quantile } from './hypotheses.js';

export const SEARCH_DEFAULTS = Object.freeze({ seed: 417, minDays: 120, suite: 'legacy', mode: 'development',
  minTrainTrades: 80, minValidationTrades: 40, minTestTrades: 40,
  minWinRate: .50, minExpectancyR: .03, minTradesPerDay: .5,
  minActiveDayFraction: .25, minProfitableMonthFraction: .5,
  maxDrawdownR: 20, shortlistSize: 12, targetPatterns: 3,
  bootstrapReps: 2000, stressCostMultiplier: 2, permutations: 0,
});
export function rng(seed) {
  let a=seed>>>0;
  return () => {a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};
}
// Fast identifier for progress consistency; not a security primitive.
export function fingerprint(value) {
  const str=typeof value==='string'?value:JSON.stringify(value);let h=2166136261;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16);
}
export function splitDays(data, minDays=120) {
  const days=[...new Set(data.clock.filter(x=>x.minute>=570 && x.minute<960).map(x=>x.day))];
  if(days.length<minDays)throw new Error(`Need at least ${minDays} trading days; found ${days.length}.`);
  const v=Math.floor(days.length*.6),t=Math.floor(days.length*.8);
  const first=day=>data.clock.findIndex(x=>x.day>=day);
  return {train:{start:20,end:first(days[v]),days:days.slice(0,v)},
    validation:{start:first(days[v]),end:first(days[t]),days:days.slice(v,t)},
    test:{start:first(days[t]),end:data.candles.length,days:days.slice(t)},
    description:'Chronological 60/20/20 split by New York dates with RTH bars. Finalists freeze before final test.'};
}
// Resample entire trading days, including days with zero trades. Clustering
// within each day is retained. Cross-day dependence remains a limitation.
export function dayBootstrapLower(trades, days, reps=2000, alpha=.05, seed=417) {
  const groups=new Map(days.map(d=>[d,{r:0,n:0}]));
  for(const t of trades){const g=groups.get(t.day);if(g){g.r+=t.rMult;g.n++;}}
  const blocks=[...groups.values()],random=rng(seed),means=[];
  if(!trades.length || !blocks.length)return null;
  for(let k=0;k<reps;k++){
    let r=0,n=0;for(let j=0;j<blocks.length;j++){const b=blocks[Math.floor(random()*blocks.length)];r+=b.r;n+=b.n;}
    means.push(n?r/n:0);
  }
  return quantile(means,alpha);
}
function reportRange(factory,candidate,range,execution) {
  const result=simulate(factory.data.candles,factory.signal(candidate),{...execution,...candidate.execution},range,factory.data);
  const stats=summarize(result.trades,range.days.length);
  const allMonths=[...new Set(range.days.map(d=>d.slice(0,7)))];
  stats.profitableMonthFraction=allMonths.filter(m=>(stats.months[m]||0)>0).length/allMonths.length;
  return {...result,stats};
}
function reasons(result, phase, cfg, execution, lower=null) {
  const s=result.stats,out=[],min=phase==='train'?cfg.minTrainTrades:phase==='validation'?cfg.minValidationTrades:cfg.minTestTrades;
  if(s.trades<min)out.push(`Only ${s.trades} trades; need ${min}`);
  if(s.winRate<cfg.minWinRate)out.push('Win rate below threshold');
  if(s.expectancyR<cfg.minExpectancyR || s.totalDollar<=0)out.push('Insufficient net expectancy');
  if(s.tradesPerDay<cfg.minTradesPerDay)out.push('Too infrequent');
  if(s.activeDayFraction<cfg.minActiveDayFraction)out.push('Too few active days');
  if(s.profitableMonthFraction<cfg.minProfitableMonthFraction)out.push('Too few profitable months');
  if(result.maxDrawdown>execution.riskDollars*cfg.maxDrawdownR)out.push('Drawdown above research limit');
  if(lower!==null && lower<=0)out.push('Day-bootstrap lower bound is not positive');
  return out;
}
function compact(result) {return {stats:result.stats,maxDrawdown:result.maxDrawdown,rejectedRisk:result.rejectedRisk};}
function rank(row) {return row.train.stats.expectancyR*Math.sqrt(row.train.stats.trades);}
export function validateSearchConfig(input={}) {
  const cfg={...SEARCH_DEFAULTS,...input};
  if(!['legacy','retest-v2'].includes(cfg.suite))throw new Error('Invalid suite');
  if(!['development','confirmatory'].includes(cfg.mode))throw new Error('Invalid mode');
  for(const k of ['minDays','minTrainTrades','minValidationTrades','minTestTrades','shortlistSize','targetPatterns','bootstrapReps'])
    if(!Number.isInteger(cfg[k]) || cfg[k]<1)throw new Error(`Invalid ${k}`);
  for(const k of ['minWinRate','minActiveDayFraction','minProfitableMonthFraction'])
    if(!Number.isFinite(cfg[k]) || cfg[k]<0 || cfg[k]>1)throw new Error(`Invalid ${k}`);
  for(const k of ['minExpectancyR','minTradesPerDay','maxDrawdownR','stressCostMultiplier'])
    if(!Number.isFinite(cfg[k]) || cfg[k]<0)throw new Error(`Invalid ${k}`);
  if(!Number.isInteger(cfg.permutations) || cfg.permutations<0)throw new Error('Invalid permutations');
  if(cfg.targetPatterns>3)throw new Error('At most three frozen finalists per experiment.');
  return cfg;
}
// Session-stratified OHLC permutation. Moves log bar shapes + volume together
// within NY minute buckets. Gaps remain at their timestamps. This is one null
// model, not proof of market independence or a universal significance test.
export function permuteCandles(candles, clock, seed) {
  const random=rng(seed),buckets=new Map(),indices=Array.from({length:candles.length},(_,i)=>i);
  for(let i=1;i<candles.length;i++){const k=clock[i].minute;if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(i);}
  for(const group of buckets.values()){
    const shuffled=[...group];for(let j=shuffled.length-1;j>0;j--){const k=Math.floor(random()*(j+1));[shuffled[j],shuffled[k]]=[shuffled[k],shuffled[j]];}
    group.forEach((idx,j)=>indices[idx]=shuffled[j]);
  }
  const out=[{...candles[0]}];
  for(let i=1;i<candles.length;i++){
    const source=candles[indices[i]],gap=candles[i].open/candles[i-1].close,open=out[i-1].close*gap;
    out.push({time:candles[i].time,open,high:open*source.high/source.open,
      low:open*source.low/source.open,close:open*source.close/source.open,volume:source.volume||0});
  }
  return out;
}
export async function runSearch(candles, options={}, hooks={}) {
  const cfg=validateSearchConfig(options.search),execution=executionConfig(options.execution);
  const quality=validateCandles(candles,execution.intervalMs), data=prepare(candles),split=splitDays(data,cfg.minDays);
  const candidates=buildCandidates(cfg.suite),dataId=fingerprint(candles),runId=fingerprint({dataId,cfg,execution,version:ENGINE_VERSION});
  let state=hooks.checkpoint || {runId,dataId,version:ENGINE_VERSION,options:{search:cfg,execution},rows:[],permutationScores:[]};
  if(state.runId!==runId)throw new Error('Checkpoint does not match these data, settings, or code version.');
  const save=async()=>{if(hooks.onCheckpoint)await hooks.onCheckpoint(state);};
  const tick=async(stage,done,total)=>{
    if(hooks.shouldStop?.())throw new Error('PAUSED: checkpoint saved; resume with the same data and settings.');
    await hooks.onProgress?.({stage,done,total});
    await new Promise(resolve=>setTimeout(resolve,0));
  };
  if(state.report)return state.report;
  const factory=createFactory(candles,split.train.end,data);
  for(let j=state.rows.length;j<candidates.length;j++){
    await tick('Training candidates',j,candidates.length);
    const candidate=candidates[j],r=reportRange(factory,candidate,split.train,execution);
    state.rows.push({candidate,train:compact(r),trainReasons:reasons(r,'train',cfg,execution)});
    await save();
  }
  // Select on TRAIN only, at most two candidates per family. Validation does
  // not trigger new variants. Test cannot select replacements.
  if(!state.shortlist){
    const counts={};
    state.shortlist=state.rows.filter(r=>!r.trainReasons.length).sort((a,b)=>rank(b)-rank(a))
      .filter(r=>{const f=r.candidate.family;counts[f]=(counts[f]||0)+1;return counts[f]<=2;}).slice(0,cfg.shortlistSize)
      .map(r=>r.candidate.id);
    state.validation=[];await save();
  }
  const purge=Math.max(...candidates.map(c=>c.execution.maxHoldBars))+execution.cooldownBars+1;
  const validationRange={...split.validation,start:split.validation.start+purge};
  const testRange={...split.test,start:split.test.start+purge};
  const costStress={...execution,commissionPerSide:execution.commissionPerSide*cfg.stressCostMultiplier,
    entrySlipTicks:execution.entrySlipTicks*cfg.stressCostMultiplier,stopSlipTicks:execution.stopSlipTicks*cfg.stressCostMultiplier,
    exitSlipTicks:execution.exitSlipTicks*cfg.stressCostMultiplier};
  for(let j=state.validation.length;j<state.shortlist.length;j++){
    await tick('Validating shortlist',j,state.shortlist.length);
    const candidate=candidates.find(c=>c.id===state.shortlist[j]);
    const r=reportRange(factory,candidate,validationRange,execution);
    const lower=dayBootstrapLower(r.trades,validationRange.days,cfg.bootstrapReps,.05/Math.max(1,state.shortlist.length),cfg.seed+j);
    const stress=reportRange(factory,candidate,validationRange,costStress);
    const failures=reasons(r,'validation',cfg,execution,lower);
    if(stress.stats.expectancyR<=0 || !stress.trades.length)failures.push('Failed doubled-cost test');
    state.validation.push({candidate,result:compact(r),lower,stress:compact(stress),failures});await save();
  }
  // Optional TRAIN-only MCPT repeats the full, finite candidate search on each
  // permutation, including motif threshold fitting. Costs are identical.
  if(cfg.permutations && !state.mcpt){
    const realBest=Math.max(...state.rows.map(r=>rank(r)));
    const trainCandles=candles.slice(0,split.train.end),trainClock=data.clock.slice(0,split.train.end);
    for(let p=state.permutationScores.length;p<cfg.permutations;p++){
      await tick('Selection-aware MCPT',p,cfg.permutations);
      const perm=permuteCandles(trainCandles,trainClock,cfg.seed+p+10000),pf=createFactory(perm,perm.length);
      let best=-Infinity;
      for(let j=0;j<candidates.length;j++){
        if(j%12===0)await tick(`MCPT ${p+1}/${cfg.permutations}`,j,candidates.length);
        const r=reportRange(pf,candidates[j],{...split.train,end:perm.length},execution);
        best=Math.max(best,r.stats.expectancyR*Math.sqrt(r.stats.trades));
      }
      state.permutationScores.push(best);await save();
    }
    state.mcpt={realBest,pValue:(1+state.permutationScores.filter(v=>v>=realBest).length)/(1+cfg.permutations),
      permutations:cfg.permutations,scope:'Entire registered candidate grid, TRAIN only; rank = mean net R times sqrt(trade count).'};
    await save();
  }
  if(!state.finalists){
    const families=new Set();
    state.finalists=state.validation.filter(v=>!v.failures.length).sort((a,b)=>b.lower-a.lower)
      .filter(v=>{if(families.has(v.candidate.family))return false;families.add(v.candidate.family);return true;})
      .slice(0,cfg.targetPatterns).map(v=>v.candidate.id);
    if(state.mcpt && state.mcpt.pValue>.05)state.finalists=[];
    state.test=[];await save();
  }
  if(cfg.mode==='confirmatory' && state.finalists.length && !state.holdoutOpened){
    // Called by UI/CLI to persist a data-level holdout lock before first use.
    await hooks.onHoldoutOpen?.({dataId,runId,finalists:state.finalists});
    state.holdoutOpened=true;await save();
  }
  for(let j=state.test.length;cfg.mode==='confirmatory' && j<state.finalists.length;j++){
    await tick('Testing frozen finalists',j,state.finalists.length);
    const candidate=candidates.find(c=>c.id===state.finalists[j]),r=reportRange(factory,candidate,testRange,execution);
    const lower=dayBootstrapLower(r.trades,testRange.days,cfg.bootstrapReps,.05/state.finalists.length,cfg.seed+500+j);
    const stress=reportRange(factory,candidate,testRange,costStress),failures=reasons(r,'test',cfg,execution,lower);
    if(stress.stats.expectancyR<=0 || !stress.trades.length)failures.push('Failed doubled-cost test');
    state.test.push({candidate,result:compact(r),lower,stress:compact(stress),failures,trades:r.trades,
      model:candidate.family==='motif'?factory.models[candidate.params.window]:null});await save();
  }
  const accepted=state.test.filter(t=>!t.failures.length);
  state.report={version:ENGINE_VERSION,runId,dataId,createdAt:new Date().toISOString(),execution,search:cfg,quality,split,
    testedCandidates:candidates.length,training:state.rows,validation:state.validation,finalists:state.test,
    frozenCandidateIds:state.finalists,holdoutOpened:!!state.holdoutOpened,
    validationPassed:state.validation.filter(v=>!v.failures.length).length,
    accepted,mcpt:state.mcpt||null,status:cfg.mode==='development'?'DEVELOPMENT_COMPLETE':accepted.length>=cfg.targetPatterns?'TARGET_MET':'EXHAUSTED',
    message:cfg.mode==='development'?`Development complete: ${state.validation.filter(v=>!v.failures.length).length} passed validation; final holdout remains closed.`:accepted.length>=cfg.targetPatterns?'Three research candidates passed; forward paper validation remains.':
      `Found ${accepted.length}/${cfg.targetPatterns}. Registered search exhausted; no thresholds were relaxed.`,
    limitations:['Historical research, not a profitability guarantee.',
      'Repeated past use of these dates by you is not detectable; previously inspected data are not untouched.',
      'Different families are not proof of independent returns; portfolio and funded-account rules are not simulated.',
      'Day bootstrap does not model dependence across days. MCPT tests one declared null model.',
      'Data source contract rolls must be verified. OHLC does not resolve intrabar ordering.']};
  await save();return state.report;
}
