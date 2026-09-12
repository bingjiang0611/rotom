// Raw maintenance probes do not broaden the registered product capabilities.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { readLocalCredential } from '../../rotom/extensions/qoder/auth.mjs';
import { CHAT_URL, normalizeSSE } from '../../rotom/extensions/qoder/transport.mjs';
export function colorImage() {
  const colors = [['red', [255,0,0]], ['green',[0,255,0]], ['blue',[0,0,255]]];
  const [name, color] = colors[randomInt(colors.length)];
  const chunk = (type, bytes) => {
    const b = Buffer.alloc(bytes.length + 12); b.writeUInt32BE(bytes.length); b.write(type, 4); bytes.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8]=8;header[9]=2;
  const pixels = Buffer.alloc(64 * (64 * 3 + 1));
  for(let y=0;y<64;y++) for(let x=0;x<64;x++) for(let c=0;c<3;c++) pixels[y*193+1+x*3+c]=color[c];
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  return { name, data: png.toString('base64') };
}
// Importing this helper never performs network I/O.
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.env.ROTOM_QODER_PROBE_LEDGER || !process.execArgv.includes('--import')) throw new Error('Use live-budget.mjs preload');
  const [model, mode] = process.argv.slice(2);
  if (!['lite','performance'].includes(model) || !['image','thinking'].includes(mode)) throw new Error('Explicit model and modality required');
  const summary = { model, mode, cost: 'unknown' };
  try {
    const { accessToken } = await readLocalCredential({ authDir: process.env.ROTOM_QODER_AUTH_DIR });
    const image = colorImage(), requestId = randomUUID();
    const content = mode === 'image' ? [{type:'text',text:'What solid color fills this image? Reply with one lowercase word: red, green, or blue.'},{type:'image_url',image_url:{url:`data:image/png;base64,${image.data}`}}] : 'Calculate 137*241. Reason carefully then reply with exactly the integer answer.';
    const response = await fetch(CHAT_URL, { method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',Accept:'text/event-stream'},
      body:JSON.stringify({model,stream:true,max_tokens:2048,enable_thinking:mode==='thinking',reasoning_effort:mode==='thinking'?'low':'none',messages:[{role:'user',content}],metadata:{context:{request_id:requestId,request_set_id:requestId,session_id:requestId,task_id:'common',client_type:'rotom'}}})});
    summary.httpStatus=response.status;
    if(!response.ok){await response.body?.cancel();throw new Error(`http_${response.status}`);}
    let text='', reasoningChars=0;
    for await (const frame of normalizeSSE(response.body)) {
      if(frame==='data: [DONE]\n\n')continue;
      const data=JSON.parse(frame.slice(6)); text+=data.choices[0]?.delta?.content??''; reasoningChars+=(data.choices[0]?.delta?.reasoning_content??'').length;
      if(data.usage)summary.usage=data.usage;
    }
    summary.reasoningPresent=reasoningChars>0;
    assert.equal(text.trim().toLowerCase(),mode==='image'?image.name:String(137*241));
    if(mode==='thinking')assert.ok(reasoningChars>0);
    summary.pass=true;
  } catch(e){summary.pass=false;summary.errorCode=e.code==='ERR_ASSERTION'?'capability_assertion_failed':e.message?.match(/Qoder: ([a-z0-9_]+)/)?.[1]??'probe_failed';process.exitCode=1;}
  console.log(JSON.stringify(summary));
}
