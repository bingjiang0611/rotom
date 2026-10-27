import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

// Synthetic reconstructions of correction patterns. No session text, IDs,
// credentials, machine addresses or user configuration belong in these fixtures.
export type QualityTask = {
	id: string;
	prompt: string;
	editable: string;
	files: Record<string, string>;
	acceptance: string;
};

export const qualityRegressionTasks: readonly QualityTask[] = [
	{
		id: "finish-all-stages",
		prompt: "完成两个阶段后再交付：normalize 把字符串数组逐项 trim 并转小写；render 对规范化结果用逗号连接。两个函数都要支持空数组。不要完成第一阶段就停下来等我说继续。",
		editable: "src/workflow.mjs",
		files: { "src/workflow.mjs": "export function normalize(values) { return values; }\nexport function render(values) { return ''; }\n" },
		acceptance: `import { normalize, render } from './src/workflow.mjs';
assert.deepEqual(normalize([' A ', 'B']), ['a', 'b']);
assert.deepEqual(normalize([]), []);
assert.equal(render([' X ', ' Y ']), 'x,y');
assert.equal(render([]), '');`,
	},
	{
		id: "check-real-connection-path",
		prompt: "直连失败，但已有 SSH 复用连接可用。只读本地 config.json 和连接选择函数，修复选择逻辑：优先可用的复用连接，否则使用可用直连，都不可用才返回 null。不要访问真实网络。",
		editable: "src/connection.mjs",
		files: {
			"config.json": '{"direct":{"available":false},"multiplex":{"available":true}}\n',
			"src/connection.mjs": "export function chooseConnection(config) { return config.direct.available ? 'direct' : null; }\n",
		},
		acceptance: `import { chooseConnection } from './src/connection.mjs';
for (const [direct, multiplex, expected] of [[false,true,'multiplex'],[true,true,'multiplex'],[true,false,'direct'],[false,false,null]]) {
 assert.equal(chooseConnection({direct:{available:direct},multiplex:{available:multiplex}}), expected);
}`,
	},
	{
		id: "add-without-replacing",
		prompt: "在 models.json 新增 id 为 model-next 的模型。保留已有模型及其全部属性，不改变默认模型。不是替换旧模型。",
		editable: "models.json",
		files: { "models.json": '{"default":"model-stable","models":[{"id":"model-stable","budget":42},{"id":"model-legacy"}]}\n' },
		acceptance: `const config = JSON.parse(readFileSync('models.json','utf8'));
assert.equal(config.default, 'model-stable');
assert.deepEqual(config.models.filter(model => model.id !== 'model-next'), [{id:'model-stable',budget:42},{id:'model-legacy'}]);
assert.equal(config.models.filter(model => model.id === 'model-next').length, 1);`,
	},
	{
		id: "structured-write-evidence",
		prompt: "修复 applied(event)：仅当 details.actionFusion 的 version===1 且 mutation==='applied' 时返回 true。展示文本不是写入证据；没有结构化证据或未知协议版本都返回 false。后续命令失败不代表写入被回滚。",
		editable: "src/phases.mjs",
		files: { "src/phases.mjs": "export function applied(event) { return event.text.startsWith('Successfully replaced'); }\n" },
		acceptance: `import { applied } from './src/phases.mjs';
assert.equal(applied({text:'Successfully replaced 1 block'}), false);
assert.equal(applied({text:'完全不同的展示文案',isError:true,details:{actionFusion:{version:1,mutation:'applied',followup:'failed'}}}), true);
assert.equal(applied({text:'Successfully replaced',details:{actionFusion:{version:2,mutation:'applied'}}}), false);
assert.equal(applied({text:'Successfully replaced',details:{actionFusion:{version:1,mutation:'unknown'}}}), false);`,
	},
	{
		id: "version-not-a-historical-mention",
		prompt: "修复 matchesCurrent(document, version)：文档必须恰好有一行以 Current baseline: 开头，且这一行精确等于 Current baseline: 加一个空格再加 version。历史段落包含版本不算匹配；重复当前字段也要拒绝。",
		editable: "src/version.mjs",
		files: { "src/version.mjs": "export function matchesCurrent(document, version) { return document.includes(version); }\n" },
		acceptance: String.raw`import { matchesCurrent } from './src/version.mjs';
assert.equal(matchesCurrent('Current baseline: 2.0\nHistory: 1.0', '2.0'), true);
assert.equal(matchesCurrent('Current baseline: 1.0\nHistory: 2.0', '2.0'), false);
assert.equal(matchesCurrent('Current baseline: 2.0\nCurrent baseline: 2.0', '2.0'), false);
assert.equal(matchesCurrent('History: 2.0', '2.0'), false);
assert.equal(matchesCurrent('Current baseline: 2.0-extra', '2.0'), false);`,
	},
	{
		id: "optional-schema-isolation",
		prompt: "修复 register(nativeAsk, registry, warn)：schemaVersion===1 才加 continuation:true；其他 schema 保留同一个原始 Ask 对象并告警一次。两种情况下都继续注册名为 later 的工具。不要吞掉 registry.add 自身的异常。",
		editable: "src/register.mjs",
		files: { "src/register.mjs": "export function register(nativeAsk, registry, warn) { if (nativeAsk.schemaVersion !== 1) throw new Error('schema mismatch'); registry.add({...nativeAsk,continuation:true}); registry.add({name:'later'}); }\n" },
		acceptance: `import { register } from './src/register.mjs';
for (const schemaVersion of [1,2,undefined]) {
 const nativeAsk={name:'ask',schemaVersion,execute(){return 'native';}};
 const tools=[],warnings=[];
 register(nativeAsk,{add(tool){tools.push(tool);}},message=>warnings.push(message));
 assert.deepEqual(tools.map(tool=>tool.name), ['ask','later']);
 assert.equal(tools[0].execute(), 'native');
 if(schemaVersion===1) { assert.equal(tools[0].continuation,true); assert.equal(warnings.length,0); }
 else { assert.equal(tools[0],nativeAsk); assert.equal(warnings.length,1); }
}
assert.throws(()=>register({schemaVersion:1},{add(){throw new Error('registry failure');}},()=>{}), /registry failure/);`,
	},
	{
		id: "warning-channel-boundary",
		prompt: "修复 reportMissing(message, ctx)：交互模式 ctx.hasUI=true 时使用 ctx.ui.notify(message,'warning')，不能发 Node warning；非交互模式调用 process.emitWarning(message,{code:'MISSING_TOOL'})。不要全局覆盖或吞掉告警。",
		editable: "src/warnings.mjs",
		files: { "src/warnings.mjs": "export function reportMissing(message, ctx) { process.emitWarning(message,{code:'MISSING_TOOL'}); }\n" },
		acceptance: `import { reportMissing } from './src/warnings.mjs';
const notifications=[],warnings=[];
process.on('warning', warning=>warnings.push(warning));
const original=process.emitWarning;
reportMissing('interactive',{hasUI:true,ui:{notify(...args){notifications.push(args);}}});
await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(notifications,[['interactive','warning']]);
assert.equal(warnings.length,0);
reportMissing('headless',{hasUI:false});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(warnings.length,1);
assert.equal(warnings[0].code,'MISSING_TOOL');
assert.equal(process.emitWarning,original);`,
	},
];

function acceptanceScript(task: QualityTask): string {
	return `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\n${task.acceptance}\n`;
}

export function qualityTaskFiles(task: QualityTask): Record<string, string> {
	return {
		"package.json": '{"private":true,"type":"module","scripts":{"test":"node test.mjs"}}\n',
		...task.files,
		"test.mjs": acceptanceScript(task),
	};
}

export async function setupQualityTask(task: QualityTask, workspace: string): Promise<void> {
	for (const [relative, content] of Object.entries(qualityTaskFiles(task))) {
		const path = join(workspace, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
}

async function workspaceFiles(root: string, relative = ""): Promise<string[]> {
	const entries = await readdir(join(root, relative), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (relative === "" && entry.name === ".git") continue;
		const path = posix.join(relative, entry.name);
		if (entry.isDirectory()) files.push(...await workspaceFiles(root, path));
		else files.push(path);
	}
	return files.sort();
}

export async function inspectQualityTask(task: QualityTask, workspace: string) {
	const expected = qualityTaskFiles(task);
	const files = await workspaceFiles(workspace);
	const sameFiles = JSON.stringify(files) === JSON.stringify(Object.keys(expected).sort());
	const unchanged = await Promise.all(Object.entries(expected).filter(([path]) => path !== task.editable).map(async ([path, content]) => {
		try { return await readFile(join(workspace, path), "utf8") === content; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
	}));
	// Execute the trusted original assertions, not the agent-editable test file.
	// This resists accidental test weakening; it is not a sandbox for hostile code.
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", acceptanceScript(task)], {
		cwd: workspace, encoding: "utf8", timeout: 10_000,
	});
	return {
		acceptancePassed: result.status === 0 && !result.error,
		scopePreserved: sameFiles && unchanged.every(Boolean),
		exitCode: result.status,
		diagnostic: (result.error?.message ?? result.stderr).slice(-2000),
	};
}
