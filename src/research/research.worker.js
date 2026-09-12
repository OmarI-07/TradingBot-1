import { runSearch } from './search.js';
let stop=false;
let ack=null;
self.onmessage=async({data})=>{
  if(data.type==='stop'){stop=true;return;}
  if(data.type==='holdoutAck'){ack?.(data);ack=null;return;}
  if(data.type!=='start')return;
  stop=false;
  try{
    const report=await runSearch(data.candles,data.options,{
      checkpoint:data.checkpoint,shouldStop:()=>stop,
      onProgress:progress=>self.postMessage({type:'progress',progress}),
      onCheckpoint:checkpoint=>self.postMessage({type:'checkpoint',checkpoint}),
      onHoldoutOpen:async lock=>{
        const reply=await new Promise(resolve=>{ack=resolve;self.postMessage({type:'holdout',lock});});
        if(reply.error)throw new Error(reply.error);
      },
    });
    self.postMessage({type:'result',report});
  }catch(error){self.postMessage({type:'error',error:error.message});}
};
