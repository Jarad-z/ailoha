import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const rootDir = process.cwd();
const startedAt = new Date();
const runStamp = startedAt.toISOString().replaceAll(/[:.]/g, "-");
const artifactDir = process.env.AGENT_ACCEPTANCE_ARTIFACT_DIR
	? join(rootDir, process.env.AGENT_ACCEPTANCE_ARTIFACT_DIR)
	: join(rootDir, "artifacts", "agent-acceptance", runStamp);
const npmCommand = "npm";

await mkdir(artifactDir, { recursive: true });
console.log(`AGENT_ACCEPTANCE_ARTIFACT_DIR=${artifactDir}`);

function commandText(args) {
	return `npm ${args.join(" ")}`;
}

function stripAnsi(value) {
	return value.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function vitestCounts(output) {
	const clean = stripAnsi(output);
	let filesPassed = 0;
	let testsPassed = 0;
	for (const match of clean.matchAll(/Test Files\s+(\d+) passed/g)) filesPassed += Number(match[1]);
	for (const match of clean.matchAll(/Tests\s+(\d+) passed/g)) testsPassed += Number(match[1]);
	return { filesPassed, testsPassed };
}

async function runStep(id, title, args, extraEnv = {}) {
	const stepStartedAt = new Date();
	console.log(`\n[${id}] ${title}: ${commandText(args)}`);
	let output = "";
	const exitCode = await new Promise((resolve) => {
		const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : npmCommand;
		const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", commandText(args)] : args;
		const child = spawn(command, commandArgs, {
			cwd: rootDir,
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnv },
			stdio: ["ignore", "pipe", "pipe"],
		});
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				output += chunk;
				process.stdout.write(chunk);
			});
		}
		child.once("error", (error) => {
			output += `\n${error.stack ?? error.message}\n`;
			resolve(1);
		});
		child.once("exit", (code) => resolve(code ?? 1));
	});
	const endedAt = new Date();
	const logFile = `${id}.log`;
	await writeFile(
		join(artifactDir, logFile),
		[
			`title=${title}`,
			`command=${commandText(args)}`,
			`startedAt=${stepStartedAt.toISOString()}`,
			`endedAt=${endedAt.toISOString()}`,
			`exitCode=${exitCode}`,
			"",
			stripAnsi(output),
		].join("\n"),
		"utf8",
	);
	return {
		id,
		title,
		command: commandText(args),
		status: exitCode === 0 ? "passed" : "failed",
		exitCode,
		startedAt: stepStartedAt.toISOString(),
		endedAt: endedAt.toISOString(),
		durationMs: endedAt.getTime() - stepStartedAt.getTime(),
		logFile,
		...vitestCounts(output),
	};
}

const steps = [];
steps.push(await runStep("01-typecheck", "TypeScript 静态检查", ["run", "check"]));
steps.push(await runStep("02-build", "全 workspace 构建", ["run", "build"]));
steps.push(await runStep("03-regression", "全量确定性回归与 E2E", ["test"]));

if (process.env.DEEPSEEK_API_KEY) {
	steps.push(
		await runStep("04-live-http-e2e", "真实 DeepSeek HTTP 黑盒 E2E", ["run", "test:e2e:live"], {
			E2E_ARTIFACT_DIR: artifactDir,
		}),
	);
	steps.push(
		await runStep("05-agents-md-live-e2e", "真实 DeepSeek AGENTS.md workspace E2E", ["run", "test:e2e:workspace-live"], {
			WORKSPACE_E2E_ARTIFACT_DIR: artifactDir,
		}),
	);
} else {
	for (const [id, title, command, logFile] of [
		["04-live-http-e2e", "真实 DeepSeek HTTP 黑盒 E2E", "npm run test:e2e:live", "04-live-http-e2e.log"],
		["05-agents-md-live-e2e", "真实 DeepSeek AGENTS.md workspace E2E", "npm run test:e2e:workspace-live", "05-agents-md-live-e2e.log"],
	]) {
		const skippedStep = {
			id,
			title,
			command,
			status: "skipped",
			exitCode: null,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			durationMs: 0,
			logFile,
			filesPassed: 0,
			testsPassed: 0,
			reason: "DEEPSEEK_API_KEY is not configured",
		};
		await writeFile(join(artifactDir, logFile), `${skippedStep.reason}\n`, "utf8");
		steps.push(skippedStep);
	}
}

const finishedAt = new Date();
const failed = steps.filter((step) => step.status === "failed");
const skipped = steps.filter((step) => step.status === "skipped");
const overallStatus = failed.length > 0 ? "failed" : skipped.length > 0 ? "passed_with_skips" : "passed";
const gitRevision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).stdout?.trim() || "unknown";
const gitStatus = spawnSync("git", ["status", "--short"], { cwd: rootDir, encoding: "utf8" }).stdout ?? "";
const manifest = {
	schemaVersion: 1,
	overallStatus,
	startedAt: startedAt.toISOString(),
	finishedAt: finishedAt.toISOString(),
	durationMs: finishedAt.getTime() - startedAt.getTime(),
	repository: { rootDir, gitRevision, dirty: gitStatus.trim().length > 0 },
	environment: {
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		deepSeekApiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
	},
	steps,
};

const regression = steps.find((step) => step.id === "03-regression");
const live = steps.find((step) => step.id === "04-live-http-e2e");
const agentsMdLive = steps.find((step) => step.id === "05-agents-md-live-e2e");
const regressionStatus = regression?.status === "passed" ? "通过" : "失败";
const liveStatus = live?.status === "passed" ? "通过" : live?.status === "skipped" ? "跳过" : "失败";
const agentsMdLiveStatus = agentsMdLive?.status === "passed" ? "通过" : agentsMdLive?.status === "skipped" ? "跳过" : "失败";
const matrix = [
	["AC-01", "直接回复且不调用工具", regressionStatus, "agent-tools/deterministic-e2e"],
	["AC-02", "工具注册：名称、描述、参数 Schema，并传给模型", regressionStatus, "agent-tools/tools + adapter/request"],
	["AC-03", "calculator、Mock search、weather 三工具执行与结果回填", regressionStatus, "agent-tools/deterministic-e2e"],
	["AC-04", "search → calculator 多轮 Loop 与数据传递", regressionStatus, "agent-tools/deterministic-e2e"],
	["AC-05", "解析 thinking、tool call、final answer，并在下一轮重放", regressionStatus, "chat-completions-adapter/integration"],
	["AC-06", "同一用户两个窗口的 Session 历史、Trace、有状态工具隔离", regressionStatus, "agent-tools/deterministic-e2e"],
	["AC-07", "纯对话追问读取已提交历史", regressionStatus, "agent-tools/deterministic-e2e"],
	["AC-08", "需要工具的追问复用历史工具结果", regressionStatus, "agent-tools/deterministic-e2e"],
	["AC-09", "Context 过长触发基础压缩并保留关键事实", regressionStatus, "agent-tools/deterministic-e2e + agent-core/context-compaction"],
	["AC-10", "达到 maxTurns 后精确终止无限工具 Loop", regressionStatus, "agent-tools/deterministic-e2e"],
	["AC-11", "未知工具、Schema 校验失败、执行/取消异常", regressionStatus, "agent-tools/deterministic-e2e + agent-core/agent"],
	["AC-12", "Run/LLM/Tool Trace 生命周期、配对、顺序与脱敏", regressionStatus, "agent-core/trace-*"],
	["AC-13", "HTTP Profile/Session/Message/Run/Transcript/SSE 黑盒链路", regressionStatus, "agent-service/http-e2e"],
	["AC-14", "真实 LLM 在三套工具 Schema 中自主选择 calculator 并闭环", liveStatus, "scripts/deepseek-http-e2e.mjs"],
	["AC-15", "真实 LLM 执行 AGENTS.md 注入、热更新、工具 Loop、Session/workspace 隔离和 HTTP allowlist", agentsMdLiveStatus, "scripts/deepseek-workspace-agents-md-live-e2e.mjs"],
];

const stepRows = steps
	.map(
		(step) =>
			`| ${step.id} | ${step.title} | ${step.status} | ${step.exitCode ?? "-"} | ${(step.durationMs / 1000).toFixed(2)}s | [${step.logFile}](./${step.logFile}) |`,
	)
	.join("\n");
const matrixRows = matrix.map((row) => `| ${row.join(" | ")} |`).join("\n");
const artifactLines = [
	"- `manifest.json`：机器可读的环境、命令、耗时和退出码。",
	"- `01-typecheck.log`、`02-build.log`、`03-regression.log`、`04-live-http-e2e.log`、`05-agents-md-live-e2e.log`：原始执行日志。",
	...(live?.status === "passed"
		? [
				"- `live-http-summary.json`：真实模型、Session、Run、候选工具、实际工具和答案摘要。",
				"- `live-http-trace.jsonl`：真实 Run 的持久化 Trace。",
				"- `live-http-transcript.json`：真实 HTTP Session Transcript。",
			]
		: []),
	...(agentsMdLive?.status === "passed"
		? [
				"- `workspace-agents-md-live-e2e-summary.json`：AGENTS.md 真实模型案例汇总。",
				"- `workspace-agents-md-live-e2e.jsonl`：请求投影、Provider 证据、Agent Trace 和逐案例断言。",
			]
		: []),
].join("\n");
const report = `# Ailoha Agent 验收测试报告

- 总体结果：**${overallStatus}**
- 开始时间：${startedAt.toISOString()}
- 结束时间：${finishedAt.toISOString()}
- Git revision：\`${gitRevision}\`（工作区${manifest.repository.dirty ? "有" : "无"}未提交改动）
- Node：${process.version}
- 确定性测试：${regression?.testsPassed ?? 0} 个测试通过，${regression?.filesPassed ?? 0} 个测试文件通过
- 真实模型 E2E：${liveStatus}
- AGENTS.md 真实模型 E2E：${agentsMdLiveStatus}

## 执行结果

| 步骤 | 内容 | 状态 | Exit code | 耗时 | 原始日志 |
|---|---|---:|---:|---:|---|
${stepRows}

## 需求覆盖矩阵

| ID | 验收场景 | 结果 | 主要证据 |
|---|---|---:|---|
${matrixRows}

## 判定说明

确定性 E2E 使用真实 Session、Context、工具实现和 Trace，仅把不稳定的模型边界替换为脚本化响应；Adapter 集成测试从 OpenAI-compatible SSE 原始分片开始，覆盖思考块、工具调用参数和最终文本解析。真实模型 E2E 则通过本地 HTTP 服务走完整 Profile → Session → Message → Run → LLM → Tool → LLM → Transcript/Trace 链路，并让模型同时看到 calculator、search、weather 三个工具的 Schema。

## 测试产物

${artifactLines}

详细用例设计见 [Agent 验收 E2E 测试方案](../../../doc/agent-acceptance-e2e-test-plan.md)。
`;

await Promise.all([
	writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
	writeFile(join(artifactDir, "test-report.md"), report, "utf8"),
]);

const relativeArtifactDir = relative(rootDir, artifactDir).replaceAll("\\", "/");
const latest = {
	overallStatus,
	finishedAt: finishedAt.toISOString(),
	artifactDir: relativeArtifactDir,
	report: `${relativeArtifactDir}/test-report.md`,
};
await mkdir(join(rootDir, "artifacts", "agent-acceptance"), { recursive: true });
await Promise.all([
	writeFile(join(rootDir, "artifacts", "agent-acceptance", "latest.json"), `${JSON.stringify(latest, null, 2)}\n`, "utf8"),
	writeFile(join(rootDir, "artifacts", "agent-acceptance", "latest-report.md"), report, "utf8"),
]);

console.log(`\nAgent acceptance result: ${overallStatus}`);
console.log(`Report: ${join(artifactDir, "test-report.md")}`);
process.exitCode = failed.length > 0 ? 1 : 0;
