// Original implementations inspired by the research repos listed in RESEARCH.md.
// These are hypotheses, not established edges. Every feature is causal.
import { prepare } from './engine.js';

export function quantile(values, p) {
  if (!values.length) return NaN;
  const a=[...values].sort((x,y)=>x-y), k=(a.length-1)*p, j=Math.floor(k);
  return a[j]+(a[Math.min(j+1,a.length-1)]-a[j])*(k-j);
}
function insertionIndex(a, value) {
  let lo=0,hi=a.length; while(lo<hi){const m=(lo+hi)>>1;if(a[m]<value)lo=m+1;else hi=m;} return lo;
}
// Threshold at i contains only observations BEFORE i.
export function priorQuantiles(values, window, low=.1, high=.9) {
  const sorted=[], lows=new Float64Array(values.length).fill(NaN), highs=lows.slice();
  const pick=p => sorted[Math.floor((sorted.length-1)*p)];
  for(let i=0;i<values.length;i++) {
    if(sorted.length===window){lows[i]=pick(low);highs[i]=pick(high);}
    if(Number.isFinite(values[i]))sorted.splice(insertionIndex(sorted,values[i]),0,values[i]);
    if(i>=window && Number.isFinite(values[i-window]))sorted.splice(insertionIndex(sorted,values[i-window]),1);
  }
  return {lows,highs};
}
// OLS slope with upper/lower envelopes around prior closes. This is an
// intentionally simpler baseline than the author's constrained optimizer.
export function trendEnvelope(candles, i, window) {
  if(i<window)return null;
  const center=(window-1)/2; let mean=0,num=0,den=0;
  for(let k=0;k<window;k++)mean+=candles[i-window+k].close/window;
  for(let k=0;k<window;k++){const x=k-center;num+=x*(candles[i-window+k].close-mean);den+=x*x;}
  const slope=num/den;let upper=-Infinity,lower=Infinity;
  for(let k=0;k<window;k++){
    const residual=candles[i-window+k].close-(mean+slope*(k-center));
    upper=Math.max(upper,residual);lower=Math.min(lower,residual);
  }
  return {upper:mean+slope*(window-center)+upper,lower:mean+slope*(window-center)+lower,slope};
}
function motifFeatures(data,i,window) {
  if(i<window || !(data.atr[i]>0))return null;
  const step=window/3, c=data.candles, a=data.atr[i];
  return [0,1,2].map(k=>(c[i-window+(k+1)*step].close-c[i-window+k*step].close)/a);
}
export function fitMotifThresholds(data, trainEnd, window) {
  const columns=[[],[],[]];
  for(let i=window;i<trainEnd;i++){
    if(data.clock[i].minute<575 || data.clock[i].minute>=950)continue;
    const f=motifFeatures(data,i,window);if(f)f.forEach((v,k)=>columns[k].push(v));
  }
  return columns.map(a=>[quantile(a,1/3),quantile(a,2/3)]);
}
function motifCode(features, thresholds) {
  return features.map((v,k)=>v<thresholds[k][0]?'D':v>thresholds[k][1]?'U':'F').join('');
}
export function buildCandidates() {
  const out=[];
  function add(family,params,targetR,exitMode='fixed') {
    const id=[family,...Object.entries(params).map(([k,v])=>`${k}=${v}`),`R=${targetR}`,exitMode].join('|');
    out.push({id,family,params,execution:{targetR,maxHoldBars:24},exitMode});
  }
  for(const window of [36,72,144])for(const buffer of [0,.15,.3])for(const r of [1,1.5])
    add('trendline',{window,buffer},r);
  for(const window of [72,144,288])for(const kappa of [.1,.25,.5])for(const mode of ['fixed','quiet-exit'])
    add('volatility',{window,kappa},1.5,mode);
  for(const window of [36,72,144])for(const wait of [3,6])for(const r of [1,1.5,2])
    add('retest',{window,wait},r);
  for(const minutes of [15,30])for(const buffer of [0,.15,.3])for(const r of [1,1.5])
    add('opening-range',{minutes,buffer},r);
  for(const window of [12,24])for(const a of ['D','F','U'])for(const b of ['D','F','U'])for(const c of ['D','F','U'])
    for(const direction of [-1,1])add('motif',{window,code:a+b+c,direction},1.5);
  for(const window of [36,72,144])for(const r of [1,1.5])add('donchian',{window},r);
  return out;
}
export function createFactory(candles, trainEnd, precomputed=null, frozenModels=null) {
  const data=precomputed || prepare(candles), cache=new Map();
  const models=frozenModels || Object.fromEntries([12,24].map(w=>[w,fitMotifThresholds(data,trainEnd,w)]));
  function signals(candidate) {
    const {family,params:p,exitMode}=candidate;
    const key=family+JSON.stringify(p)+exitMode;
    if(cache.has(key))return cache.get(key);
    const values=new Int8Array(candles.length), exits=new Uint8Array(candles.length);
    if(family==='volatility'){
      const intensity=new Float64Array(candles.length).fill(NaN);let acc=0;
      for(let i=0;i<candles.length;i++){
        if(!(data.atr[i]>0))continue;
        acc=Math.exp(-p.kappa)*acc+(candles[i].high-candles[i].low)/data.atr[i];intensity[i]=p.kappa*acc;
      }
      const {lows,highs}=priorQuantiles(intensity,p.window);let quiet=-1;
      for(let i=1;i<candles.length;i++){
        if(intensity[i]<lows[i]){quiet=i;exits[i]=exitMode==='quiet-exit'?1:0;}
        if(quiet>=0 && intensity[i]>highs[i] && intensity[i-1]<=highs[i-1])
          values[i]=Math.sign(candles[i].close-candles[quiet].close);
      }
    } else if(family==='motif'){
      for(let i=p.window;i<candles.length;i++){
        const f=motifFeatures(data,i,p.window);
        if(f && motifCode(f,models[p.window])===p.code)values[i]=p.direction;
      }
    } else if(family==='opening-range'){
      let day='',high=-Infinity,low=Infinity,count=0,fired=false;
      for(let i=0;i<candles.length;i++){
        const {day:d,minute}=data.clock[i],c=candles[i];
        if(d!==day){day=d;high=-Infinity;low=Infinity;count=0;fired=false;}
        if(minute>=570 && minute<570+p.minutes){high=Math.max(high,c.high);low=Math.min(low,c.low);count++;continue;}
        if(minute<570+p.minutes || minute>=720 || fired || count!==p.minutes/5 || !(data.atr[i]>0))continue;
        if(c.close>high+p.buffer*data.atr[i]){values[i]=1;fired=true;}
        else if(c.close<low-p.buffer*data.atr[i]){values[i]=-1;fired=true;}
      }
    } else {
      let pending=null,priorDir=0;
      for(let i=p.window;i<candles.length;i++){
        let upper,lower;
        if(family==='donchian' || family==='retest'){
          upper=-Infinity;lower=Infinity;
          for(let k=i-p.window;k<i;k++){upper=Math.max(upper,candles[k].high);lower=Math.min(lower,candles[k].low);}
        }else({upper,lower}=trendEnvelope(candles,i,p.window));
        const c=candles[i],buffer=(p.buffer||0)*data.atr[i];
        const direction=c.close>upper+buffer?1:c.close<lower-buffer?-1:0;
        if(family==='retest'){
          if(pending){
            if(i-pending.i>p.wait || data.clock[i].day!==data.clock[pending.i].day)pending=null;
            else if(pending.direction===1 && c.low<=pending.level && c.close>pending.level){values[i]=1;pending=null;}
            else if(pending.direction===-1 && c.high>=pending.level && c.close<pending.level){values[i]=-1;pending=null;}
          }
          if(!pending && direction && !values[i])pending={i,direction,level:direction===1?upper:lower};
        }else if(direction && direction!==priorDir)values[i]=direction;
        priorDir=direction;
      }
    }
    const result={values,exits}; cache.set(key,result);return result;
  }
  return {data,models,signal(candidate){const s=signals(candidate);return i=>({direction:s.values[i],exit:!!s.exits[i]});}};
}
