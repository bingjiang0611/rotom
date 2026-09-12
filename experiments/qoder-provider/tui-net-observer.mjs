// Maintenance-only metadata journal. No headers, request bodies, error bodies or URLs.
import {channel} from 'node:diagnostics_channel';
import {constants,openSync,fstatSync,writeSync,fsyncSync,closeSync,realpathSync} from 'node:fs';
import {dirname,basename} from 'node:path';
const path=process.env.ROTOM_QODER_PROBE_TUI_EVENTS,ledger=process.env.ROTOM_QODER_PROBE_LEDGER;
if(process.env.ROTOM_QODER_PROBE_NO_MODELS!=='1'||!path||!ledger||dirname(path)!==dirname(ledger)||!/^tui-events-[a-f0-9-]{36}\.jsonl$/.test(basename(path))||realpathSync(path)!==path)process.exit(87);
const requests=new WeakMap();let sequence=0;
function append(value){let fd;try{fd=openSync(path,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);const s=fstatSync(fd),bytes=Buffer.from(JSON.stringify(value)+'\n');if(!s.isFile()||s.uid!==process.getuid()||s.mode&0o077||s.size+bytes.length>65536)throw 0;if(writeSync(fd,bytes)!==bytes.length)throw 0;fsyncSync(fd);}catch{process.exit(87);}finally{if(fd!==undefined)closeSync(fd);}}
channel('undici:request:create').subscribe(({request:r})=>{
 const host=String(r.origin),p=r.path;
 const kind=host==='https://api2-v2.qoder.sh'?'model':host==='https://api2.qoder.sh'?p.startsWith('/algo/api/v2/model/list?')?'catalog':'model':host==='https://openapi.qoder.sh'?p==='/api/v2/quota/usage'?'quota':'auth':'other';
 const item={id:`${process.pid}:${++sequence}`,kind};requests.set(r,item);append({...item,event:'start'});
});
for(const [name,event] of [['undici:request:trailers','end'],['undici:request:error','error']])channel(name).subscribe(({request})=>{const item=requests.get(request);if(item){append({...item,event});requests.delete(request);}});
