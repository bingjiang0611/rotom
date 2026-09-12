// Native session metadata audit; never return messages, tool arguments or paths.
import fs from 'node:fs';
import path from 'node:path';
export function auditThinking(root, parentFile) {
 const sessions=[];const parent=fs.realpathSync(parentFile);let bytes=0,files=0;
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('session symlink');
  if(entry.isDirectory()){walk(file);continue;}if(!entry.name.endsWith('.jsonl'))continue;
  if(!entry.isFile())throw Error('non-regular session');
  const size=fs.statSync(file).size;bytes+=size;if(++files>256||size>8*1024*1024||bytes>64*1024*1024)throw Error('session audit budget');
  let thinking,sessionId,assistantCount=0,offCount=0,modelCount=0;
  for(const line of fs.readFileSync(file,'utf8').split('\n')){if(!line.trim())continue;const e=JSON.parse(line);
   if(e.type==='session')sessionId=e.id;
   if(e.type==='thinking_level_change')thinking=e.thinkingLevel;
   if(e.type==='message'&&e.message?.role==='assistant'){assistantCount++;if(thinking==='off')offCount++;if(e.message.provider==='openai-codex'&&e.message.model==='gpt-5.4-mini')modelCount++;}
  }
  if(assistantCount)sessions.push({sessionId,parent:fs.realpathSync(file)===parent,assistantCount,offCount,modelCount});
 }}
 walk(root);
 return {sessions,pass:sessions.some(s=>s.parent)&&sessions.every(s=>s.offCount===s.assistantCount&&s.modelCount===s.assistantCount),childSessions:sessions.filter(s=>!s.parent).length};
}
