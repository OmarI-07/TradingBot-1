import { useEffect, useRef, useState } from 'react';
import { fetchSelectedMonths, getAvailableMonths } from '../massiveFinance';
import { parseCandles, tradeCSV } from '../research/data.js';
import { buildCandidates } from '../research/hypotheses.js';

const KEY='nq_research_checkpoint_v1',LOCKS='nq_research_holdouts_v1';
function download(name,text,type='application/json'){
  const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const pct=v=>`${(v*100).toFixed(1)}%`;
export default function PatternResearch(){
  const [candles,setCandles]=useState(null),[months,setMonths]=useState([]),[error,setError]=useState('');
  const [running,setRunning]=useState(false),[loading,setLoading]=useState(false),[progress,setProgress]=useState(null),[report,setReport]=useState(null);
  const [mcpt,setMcpt]=useState(false),[risk,setRisk]=useState(100),[pointValue,setPointValue]=useState(2);
  const [minWin,setMinWin]=useState(50),[rate,setRate]=useState(.5);
  const worker=useRef(null),checkpoint=useRef(null);
  useEffect(()=>{
    try{checkpoint.current=JSON.parse(localStorage.getItem(KEY)||'null');if(checkpoint.current?.report)setReport(checkpoint.current.report);}catch{}
    return()=>worker.current?.terminate();
  },[]);
  async function loadMonths(){
    setLoading(true);setError('');
    try{setCandles(await fetchSelectedMonths('NQ','5m',getAvailableMonths(48).filter(m=>months.includes(m.key))));}
    catch(e){setError(e.message);}finally{setLoading(false);}
  }
  async function loadFile(file){try{setCandles(parseCandles(await file.text(),file.name));setError('');}catch(e){setError(e.message);}}
  function start(resume){
    if(!candles?.length){setError('Load NQ 5-minute candles first.');return;}
    setError('');setReport(null);setRunning(true);
    const w=new Worker(new URL('../research/research.worker.js',import.meta.url),{type:'module'});worker.current=w;
    w.onerror=e=>{setError(e.message||'Worker failed');setRunning(false);w.terminate();};
    w.onmessage=({data})=>{
      if(data.type==='progress')setProgress(data.progress);
      if(data.type==='checkpoint'){
        checkpoint.current=data.checkpoint;
        try{localStorage.setItem(KEY,JSON.stringify(data.checkpoint));}catch{setError('Browser storage is full. Download the checkpoint before closing this page.');}
      }
      if(data.type==='holdout'){
        try{
          const locks=JSON.parse(localStorage.getItem(LOCKS)||'{}'),old=locks[data.lock.dataId];
          if(old && old.runId!==data.lock.runId)throw new Error('These data already exposed a holdout under different settings. Use fresh data.');
          locks[data.lock.dataId]=data.lock;localStorage.setItem(LOCKS,JSON.stringify(locks));w.postMessage({type:'holdoutAck'});
        }catch(e){w.postMessage({type:'holdoutAck',error:e.message});}
      }
      if(data.type==='result'){setReport(data.report);setRunning(false);w.terminate();}
      if(data.type==='error'){setError(data.error);setRunning(false);w.terminate();}
    };
    w.postMessage({type:'start',candles,checkpoint:resume?checkpoint.current:null,
      options:resume && checkpoint.current?.options ? checkpoint.current.options : {execution:{riskDollars:Number(risk),pointValue:Number(pointValue)},
        search:{minWinRate:Number(minWin)/100,minTradesPerDay:Number(rate),permutations:mcpt?199:0}}});
  }
  const inputStyle={background:'var(--surface)',color:'var(--text)',border:'1px solid var(--border)',padding:8,borderRadius:6,width:90};
  return <div className="card" style={{marginBottom:20}}>
    <h2>Pattern Research — new hypotheses</h2>
    <p style={{color:'var(--text-muted)',lineHeight:1.6}}>
      Search {buildCandidates().length} registered candidates across six families. Learn price-shape categories on training data,
      validate a shortlist, then test up to three frozen finalists. A run can finish with zero qualifying patterns.
      This panel is research only. Nothing is sent to your live bot.
    </p>
    <p>Use at least 120 trading days of NQ 5-minute candles, with UTC timestamps at bar open.
      The final 20% must be dates you have not already used to choose strategies.</p>
    <label>Candle CSV or JSON <input type="file" accept=".csv,.json" disabled={running||loading} onChange={e=>e.target.files[0]&&loadFile(e.target.files[0])}/></label>
    <details style={{marginTop:14}}><summary>Load months using your existing Massive connection</summary>
      <p>Select consecutive months. Your existing provider’s permissions, rate limits, and data charges apply.</p>
      <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{getAvailableMonths(48).map(m=><label key={m.key} style={{fontSize:12}}>
        <input type="checkbox" disabled={running||loading} checked={months.includes(m.key)} onChange={()=>setMonths(a=>a.includes(m.key)?a.filter(k=>k!==m.key):[...a,m.key])}/>{m.key}
      </label>)}</div>
      <button className="btn-sm" disabled={running||loading||!months.length} onClick={loadMonths}>{loading?'Loading candles…':'Load selected months'}</button>
    </details>
    {candles&&<p>{candles.length.toLocaleString()} candles loaded. <button className="btn-sm" onClick={()=>download('nq-candles.json',JSON.stringify(candles))}>Export candles</button></p>}
    <div style={{display:'flex',flexWrap:'wrap',gap:16,margin:'16px 0'}}>
      <label>Execution contract<br/><select style={inputStyle} value={pointValue} disabled={running} onChange={e=>setPointValue(+e.target.value)}><option value={2}>MNQ</option><option value={20}>NQ</option></select></label>
      <label>Risk budget $<br/><input style={inputStyle} type="number" min={1} value={risk} disabled={running} onChange={e=>setRisk(e.target.value)}/></label>
      <label>Minimum win %<br/><input style={inputStyle} type="number" min={0} max={100} value={minWin} disabled={running} onChange={e=>setMinWin(e.target.value)}/></label>
      <label>Trades / day<br/><input style={inputStyle} type="number" min={0} step={.1} value={rate} disabled={running} onChange={e=>setRate(e.target.value)}/></label>
    </div>
    <label><input type="checkbox" checked={mcpt} disabled={running} onChange={e=>setMcpt(e.target.checked)}/> Repeat the full training search on 199 permutations (much slower)</label>
    <p style={{fontSize:12,color:'var(--text-muted)'}}>Default cost assumption: $0.74 per contract per side, 1 tick entry/exit, 2 ticks on stops; verify your fees before relying on results.
      Regular-session entries only; flatten by 15:55 New York time. Risk and drawdown limits are research settings, not a funded firm’s rules.</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:10,margin:'12px 0'}}>
      <button className="btn-green" disabled={running||loading||!candles} onClick={()=>start(false)}>Start registered search</button>
      <button className="btn-sm" disabled={running||!candles||!checkpoint.current} onClick={()=>start(true)}>Resume same experiment</button>
      <button className="btn-sm" disabled={!running} onClick={()=>worker.current?.postMessage({type:'stop'})}>Pause</button>
      <button className="btn-sm" onClick={()=>checkpoint.current&&download('checkpoint.json',JSON.stringify(checkpoint.current,null,2))}>Download checkpoint</button>
      <label style={{fontSize:12}}>Restore checkpoint <input type="file" accept=".json" disabled={running} onChange={async e=>{try{checkpoint.current=JSON.parse(await e.target.files[0].text());setError('Checkpoint restored. Load the same candles and settings, then Resume.');}catch(x){setError(x.message);}}}/></label>
    </div>
    {running&&progress&&<p role="status">{progress.stage}: {progress.done} / {progress.total}. Keep this tab open, or use the Node runner for long jobs.</p>}
    {error&&<p role="alert" style={{color:'var(--amber)'}}>{error}</p>}
    {report&&<>
      <h3>{report.message}</h3>
      <p>{report.testedCandidates} candidates screened; {report.validation.length} validated; {report.finalists.length} finalists tested.</p>
      {!report.mcpt&&<p>Selection-aware MCPT was not run. This report does not establish significance for the full search.</p>}
      {report.mcpt&&<p>Training search MCPT p-value: {report.mcpt.pValue.toFixed(4)}.</p>}
      <button className="btn-sm" onClick={()=>download('research-report.json',JSON.stringify(report,null,2))}>Download full report</button>
      <div style={{overflowX:'auto'}}><table style={{width:'100%',fontSize:13,marginTop:14}}><thead><tr><th>Frozen finalist</th><th>Trades</th><th>Win rate</th><th>Net R/trade</th><th>Result</th></tr></thead>
        <tbody>{report.finalists.map((r,i)=><tr key={r.candidate.id}><td>{r.candidate.family}<br/><small>{JSON.stringify(r.candidate.params)}</small></td><td>{r.result.stats.trades}</td><td>{pct(r.result.stats.winRate)}</td><td>{r.result.stats.expectancyR.toFixed(3)}</td><td>{r.failures.length?r.failures.join('; '):'Passed historical gates'}<br/><button className="btn-sm" onClick={()=>download(`finalist-${i+1}.csv`,tradeCSV(r.trades),'text/csv')}>Trades CSV</button></td></tr>)}</tbody></table></div>
      <details><summary>Training and validation diagnostics</summary><div style={{maxHeight:360,overflow:'auto'}}>{report.training.map(r=><p key={r.candidate.id} style={{fontSize:12}}>{r.candidate.id}<br/>{r.train.stats.trades} trades · {pct(r.train.stats.winRate)} wins · {r.train.stats.expectancyR.toFixed(3)}R · {r.trainReasons.join('; ')||'Passed training gates'}</p>)}</div></details>
    </>}
  </div>;
}
