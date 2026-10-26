// Synthetic executable only. Not shipped or referenced by the product launcher.
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
export async function fakeJudgeLauncher(directory) {
	const launcher = join(directory, "fake-launcher.mjs"), control = join(directory, "fake-control.json"), calls = join(directory, "fake-calls.jsonl");
	await writeFile(control, JSON.stringify({ mode: "ok" }));
	await writeFile(launcher, `#!${process.execPath}
import { readFile, appendFile, readdir, stat } from 'node:fs/promises';
const args=process.argv.slice(2), input=[];
for await(const chunk of process.stdin)input.push(chunk);
const body=Buffer.concat(input).toString('utf8');
await appendFile(${JSON.stringify(calls)},JSON.stringify({args,body,cwd:process.cwd(),files:await readdir(process.cwd()),mode:(await stat(process.cwd())).mode&511,pid:process.pid,node:process.env.ROTOM_NODE,secret:Object.hasOwn(process.env,'ROTOM_FAKE_SECRET')})+'\\n',{mode:384});
const control=JSON.parse(await readFile(${JSON.stringify(control)},'utf8'));
if(args.includes('--list-models')){if(control.modelsFail)process.exit(7);const catalog=JSON.stringify({models:[{id:'fake/model'}],defaultModel:'fake/model'});if(control.modelsStderr)console.error(catalog);else console.log(catalog);process.exit(0);}
if(control.mode==='hang'){setInterval(()=>{},1000);}
else if(control.mode==='fail'){console.error('synthetic launcher failure');process.exit(7);}
else if(control.mode==='oversized'){process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);}
else {
 const result={suggestedVerdict:'fail',confidence:0.87,summary:'合成复盘：结果仍需核对。',firstProblem:{event:3,description:'合成工具结果不符合要求'},categories:['wrong_result'],evidence:[{event:3,quote:'合成错误'}],suggestions:['核对结果并补充验证。']};
 const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:control.mode==='invalid'?'不是 JSON <script>':JSON.stringify(result)}],usage:{input:100,output:40,cost:{total:0.003}}};
 console.log(JSON.stringify({type:'message_end',message}));console.log(JSON.stringify({type:'agent_end',messages:[message]}));
}
`, { mode: 0o700 });
	await chmod(launcher, 0o700);
	return { launcher, control, calls };
}
