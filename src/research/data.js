// Only candle ingestion, not an import of backtest trade CSVs.
export function parseCandles(text, filename='candles.csv') {
  if(filename.toLowerCase().endsWith('.json')){
    const v=JSON.parse(text);return Array.isArray(v)?v:v.candles || v.bars || [];
  }
  const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  function row(line){
    const out=[];let value='',quote=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];if(c==='"'){if(quote && line[i+1]==='"'){value+='"';i++;}else quote=!quote;}
      else if(c===',' && !quote){out.push(value.trim());value='';}else value+=c;
    }
    if(quote)throw new Error('Multiline CSV fields are not supported for candles.');
    out.push(value.trim());return out;
  }
  const header=row(lines.shift()).map(s=>s.toLowerCase());
  const timeKey=['time','timestamp','date','datetime'].find(s=>header.includes(s));
  if(!timeKey || !['open','high','low','close'].every(k=>header.includes(k)))
    throw new Error('Candle CSV needs time,open,high,low,close,volume. Trade-export CSVs cannot reconstruct candles.');
  return lines.filter(s=>s.trim()).map((line,i)=>{
    const cells=row(line),r=Object.fromEntries(header.map((k,j)=>[k,cells[j]]));
    const raw=r[timeKey];let time;
    if(/^\d+(\.\d+)?$/.test(raw)){time=Number(raw);if(time<1e12)time*=1000;}
    else {if(!/(Z|[+-]\d{2}:?\d{2})$/.test(raw))throw new Error(`Row ${i+2}: timestamp needs Z or an explicit timezone offset.`);time=Date.parse(raw);}
    return {time,open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume||0)};
  });
}

export function tradeCSV(trades) {
  const fields=['entryTime','exitTime','side','entryPrice','exitPrice','contracts','stopPrice','targetPrice','riskDollars','rMult','dollarPnl','commission','reason'];
  return [fields.join(','),...trades.map(t=>fields.map(k=>k.endsWith('Time')?new Date(t[k]).toISOString():t[k]).join(','))].join('\n');
}
