import fs from 'node:fs/promises';
import path from 'node:path';
import { runSearch } from '../src/research/search.js';
import { parseCandles, tradeCSV } from '../src/research/data.js';

const args=process.argv.slice(2),flags={};
for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--') || !args[i+1])throw new Error('Flags need values.');flags[args[i].slice(2)]=args[i+1];}
if(!flags.data){
  console.log('Usage: node research/run.mjs --data candles.csv --out research-runs/first [--config research/config.json] [--permutations 199]');
  process.exit(0);
}
const out=path.resolve(flags.out || 'research-runs/first');await fs.mkdir(out,{recursive:true});
const options=flags.config?JSON.parse(await fs.readFile(flags.config,'utf8')):{};
if(flags.permutations!==undefined)options.search={...options.search,permutations:Number(flags.permutations)};
const input=await fs.readFile(flags.data,'utf8'),candles=parseCandles(input,flags.data);
const checkpointPath=path.join(out,'checkpoint.json');
let checkpoint=null;try{checkpoint=JSON.parse(await fs.readFile(checkpointPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
let stopped=false,lastLog=0;process.on('SIGINT',()=>{stopped=true;console.log('\nPausing at the next checkpoint.');});
async function atomic(file,value){const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2));await fs.rename(tmp,file);}
try{
  const report=await runSearch(candles,options,{
    checkpoint,shouldStop:()=>stopped,
    onCheckpoint:s=>atomic(checkpointPath,s),
    onProgress:p=>{if(Date.now()-lastLog>1500 || p.done===0){console.log(`${p.stage}: ${p.done}/${p.total}`);lastLog=Date.now();}},
    onHoldoutOpen:async lock=>{
      // Shared across run directories in this project. Does not prevent someone
      // deliberately deleting records or changing data; keep the experiment log.
      const dir=path.resolve('research-runs/holdout-locks');await fs.mkdir(dir,{recursive:true});
      const file=path.join(dir,lock.dataId+'.json');
      try{await fs.writeFile(file,JSON.stringify(lock,null,2),{flag:'wx'});}
      catch(e){
        if(e.code!=='EEXIST')throw e;
        const previous=JSON.parse(await fs.readFile(file,'utf8'));
        if(previous.runId!==lock.runId)throw new Error('This data set already exposed its holdout under different settings. Use genuinely fresh test data.');
      }
    },
  });
  await atomic(path.join(out,'report.json'),report);
  for(const [i,r] of report.finalists.entries())await fs.writeFile(path.join(out,`finalist-${i+1}-trades.csv`),tradeCSV(r.trades));
  console.log(report.message);console.log(`Report: ${path.join(out,'report.json')}`);
}catch(e){console.error(e.message);process.exitCode=e.message.startsWith('PAUSED:')?0:1;}
