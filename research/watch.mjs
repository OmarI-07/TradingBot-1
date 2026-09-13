// Persistent local research worker. It never downloads data or places orders.
// An external data collector must append completed candles to the input file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCandles,tradeCSV } from '../src/research/data.js';
import { runSearch,fingerprint,splitDays,validateSearchConfig } from '../src/research/search.js';
import { prepare,validateCandles,ENGINE_VERSION } from '../src/research/engine.js';
const argv=process.argv.slice(2),flags={};
for(let i=0;i<argv.length;i+=2){if(!argv[i+1])throw new Error('Each flag needs a value.');flags[argv[i].replace(/^--/,'')]=argv[i+1];}
if(!flags.data){
  console.log('Usage: node research/watch.mjs --data candles.csv --out research-runs/watch --config research/config.json --poll 60');
  process.exit(0);
}
const poll=Number(flags.poll || 60);if(!Number.isFinite(poll)||poll<5)throw new Error('Poll interval must be at least 5 seconds.');
const options=flags.config?JSON.parse(await fs.readFile(flags.config,'utf8')):{};
const search=validateSearchConfig(options.search),out=path.resolve(flags.out||'research-runs/watch');
if(search.mode==='development')throw new Error('Use run.mjs for a single development experiment. Watch mode requires explicit confirmatory mode.');
const settingsId=fingerprint({options,version:ENGINE_VERSION});await fs.mkdir(out,{recursive:true});
const stateFile=path.join(out,'watch-state.json');let state={settingsId,lastTestEnd:0,attemptedData:null},stopped=false,lastMessage='';
try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(state.settingsId!==settingsId)throw new Error('Watch settings changed. Start a documented new experiment; preserve prior holdout history.');
process.on('SIGINT',()=>{stopped=true;console.log('\nStopping after the current checkpoint.');});
async function atomic(file,value){const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2));await fs.rename(tmp,file);}
function say(message){if(message!==lastMessage){console.log(message);lastMessage=message;}}
while(!stopped && state.status!=='TARGET_MET'){
  try{
    const candles=parseCandles(await fs.readFile(flags.data,'utf8'),flags.data);validateCandles(candles);
    const dataId=fingerprint(candles);
    if(state.attemptedData===dataId){say('Waiting for newly completed candles. The previous search is exhausted.');}
    else {
      if(state.prefixLength && (candles.length<state.prefixLength || fingerprint(candles.slice(0,state.prefixLength))!==state.prefixId))
        throw new Error('Append-only input required: previously inspected candles changed. Preserve this history and review the data source.');
      const split=splitDays(prepare(candles),search.minDays);
      if(state.inProgressData!==dataId && candles[split.test.start].time<=state.lastTestEnd){
        say('Waiting for enough appended history: the new final test must start after the last exposed test ended.');
      }else{
        const runDir=path.join(out,dataId);await fs.mkdir(runDir,{recursive:true});
        const cpFile=path.join(runDir,'checkpoint.json');let checkpoint=null;
        try{checkpoint=JSON.parse(await fs.readFile(cpFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
        say(`Researching ${candles.length} candles; goal ${search.targetPatterns} qualifying patterns.`);
        let lastLog=0;
        const report=await runSearch(candles,options,{
          checkpoint,shouldStop:()=>stopped,onCheckpoint:s=>atomic(cpFile,s),
          onProgress:p=>{if(Date.now()-lastLog>5000){console.log(`${p.stage}: ${p.done}/${p.total}`);lastLog=Date.now();}},
          onHoldoutOpen:async lock=>{
            const lockDir=path.resolve('research-runs/holdout-locks');await fs.mkdir(lockDir,{recursive:true});
            const lockFile=path.join(lockDir,`${dataId}.json`);
            try{await fs.writeFile(lockFile,JSON.stringify(lock),{flag:'wx'});}catch(e){
              if(e.code!=='EEXIST')throw e;
              const prior=JSON.parse(await fs.readFile(lockFile,'utf8'));
              if(prior.runId!==lock.runId)throw new Error('These data already exposed the holdout under different settings.');
            }
            // Reserve the entire test period before exposure, even if stopped.
            state.lastTestEnd=candles.at(-1).time;state.inProgressData=dataId;await atomic(stateFile,state);
          },
        });
        await atomic(path.join(runDir,'report.json'),report);
        for(const [i,r] of report.finalists.entries())await fs.writeFile(path.join(runDir,`finalist-${i+1}-trades.csv`),tradeCSV(r.trades));
        state={...state,status:report.status,attemptedData:dataId,inProgressData:null,
          prefixLength:candles.length,prefixId:dataId,lastReport:path.join(runDir,'report.json')};
        await atomic(stateFile,state);say(report.message);
      }
    }
  }catch(e){
    if(e.message.startsWith('PAUSED:'))break;
    say(`Waiting: ${e.message}`);
  }
  // Short sleeps let Ctrl+C interrupt even when waiting for new data.
  for(let n=0;n<poll && !stopped && state.status!=='TARGET_MET';n++)await new Promise(r=>setTimeout(r,1000));
}
if(state.status==='TARGET_MET')console.log(`Target met by historical gates. Review ${state.lastReport} and forward-paper-test before any live use.`);
