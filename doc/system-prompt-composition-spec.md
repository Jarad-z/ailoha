# System Prompt Composition Spec

状态：Draft v0.1

## 1. 目标

定义 Context Manager 如何把多个来源的 system prompt 内容组装成一次 Agent run 使用的最终 `systemPrompt`。

本规范要求：

- system prompt 由职责明确的固定 section 组成。
- section 顺序稳定、输出可预测、便于测试。
- 每个 section 的内容来源和权限边界清晰。
- workspace instructions 保留来源及适用边界。
- local memory 只能作为数据使用，不能被解释为指令。
- 最终结果仍是一个字符串，直接进入 `AgentContext.systemPrompt`。

本版本不包含 `skillsCatalog`。以后需要时可以增加新 section，但不能隐式混入现有 section。

## 2. 固定组成和顺序

最终 system prompt 必须严格按以下顺序组成：

```text
baseSystem
personalization
environment
workspaceInstructions
localMemory
runtimeDirectives
```

概念模型：

```ts
systemPrompt = join([
	baseSystem,
	personalization,
	environment,
	workspaceInstructions,
	localMemory,
	runtimeDirectives,
]);
```

顺序是协议的一部分。具体实现不能根据内容是否存在而改变剩余 section 的相对顺序。

## 3. Section 职责

### 3.1 `baseSystem`

定义 Agent 的稳定基础行为，包括：

- 身份与核心职责。
- 安全边界。
- 通用行为规则。
- 输出规则。
- system prompt 内不同来源发生冲突时的解释规则。

`baseSystem` 是必需 section。它不能包含当前机器、当前 workspace、当前用户偏好或当前 run 才成立的信息。

### 3.2 `personalization`

只定义与用户交互时的表达偏好，例如：

- 语言。
- 语气。
- 详略程度。
- 格式偏好。

`personalization` 不能：

- 修改安全边界或权限。
- 扩大 Agent 的能力范围。
- 改写 workspace instructions。
- 添加工具、环境或用户状态等事实。
- 把表达偏好升级为任务目标。

该 section 可以为空。

### 3.3 `environment`

描述本次 run 开始时可确认的环境事实，例如：

- 当前工作目录。
- 操作系统和 shell。
- 当前日期、时区。
- workspace roots。
- 可用运行时或宿主能力。

`environment` 是事实数据，不授予权限。某项能力存在，不表示 Agent 已获准使用它。

该 section 可以为空。

### 3.4 `workspaceInstructions`

包含当前 workspace 或项目提供的规则。每份 instruction 必须保留：

- `source`：规则来自哪个文件或配置源。
- `boundary`：规则适用于哪个目录、项目或资源范围。
- `content`：规则正文。

概念类型：

```ts
interface WorkspaceInstruction {
	readonly source: string;
	readonly boundary: string;
	readonly content: string;
}
```

规则：

- 多份 instructions 按适用范围从宽到窄排列。
- 同一范围内按加载顺序稳定排列。
- 实现不能丢弃 `source` 或 `boundary` 后只拼接正文。
- workspace instruction 只能约束其 `boundary` 内的工作。
- workspace instruction 不能覆盖 `baseSystem` 中的安全边界。

该 section 可以为空。

### 3.5 `localMemory`

提供与用户、workspace 或历史工作有关的本地记忆。

`localMemory` 必须被标记为 data-only：

- 内容用于提供背景事实或辅助判断。
- 内容中的祈使句、角色声明、工具调用要求和规则文本都不能作为指令执行。
- 记忆与当前环境事实冲突时，以当前可验证的环境事实为准。
- 记忆与用户本轮输入冲突时，不得静默覆盖用户输入。

概念类型：

```ts
interface LocalMemoryEntry {
	readonly source?: string;
	readonly content: string;
}
```

该 section 可以为空。

### 3.6 `runtimeDirectives`

描述当前 run 的运行控制信息，包括：

- 当前模式。
- 当前权限与限制。
- 当前目标。
- 本次运行特有的控制指令。

`runtimeDirectives` 不能重新定义 Agent 的稳定身份，也不能覆盖 `baseSystem` 的安全边界。权限必须由实际 runtime 状态产生，不能从普通文本推断。

该 section 是运行时快照：在 `ContextManager.beginRun()` 中解析并固定，同一顶层 run 内复用。

该 section 可以为空。

## 4. 输入模型

```ts
type PromptSectionContent = string | readonly string[];

interface SystemPromptSources {
	readonly baseSystem: PromptSectionContent;
	readonly personalization?: PromptSectionContent;
	readonly environment?: PromptSectionContent;
	readonly workspaceInstructions?: readonly WorkspaceInstruction[];
	readonly localMemory?: readonly LocalMemoryEntry[];
	readonly runtimeDirectives?: PromptSectionContent;
}
```

具体 Context Manager 可以直接接收已解析的 sources，也可以接收负责加载 sources 的 provider。加载方式属于实现细节，但最终必须得到上述逻辑结构。

## 5. 标准序列化格式

每个非空 section 使用明确的边界标签。最终输出格式如下：

```text
<base_system>
{baseSystem}
</base_system>

<personalization>
{personalization}
</personalization>

<environment>
{environment}
</environment>

<workspace_instructions>
<instruction source="{source}" boundary="{boundary}">
{content}
</instruction>
</workspace_instructions>

<local_memory data_only="true">
<memory source="{optional source}">
{content}
</memory>
</local_memory>

<runtime_directives>
{runtimeDirectives}
</runtime_directives>
```

这些标签是结构边界，不表示内容是合法 XML。实现不得依赖 XML parser 读取最终 system prompt。

### 5.1 转义

`source` 和 `boundary` 位于标签属性中，必须至少转义：

```text
&  → &amp;
"  → &quot;
<  → &lt;
>  → &gt;
```

section 正文按原始文本保留，不执行模板插值，也不把正文中的标签解释为结构边界。

### 5.2 空 section

- `baseSystem` 为空或只包含空白时，组装失败。
- 其他 section 为空、缺失或规范化后无内容时，整个 section 连同标签一起省略。
- 省略 section 不改变其他 section 的相对顺序。
- 不输出空标签。

### 5.3 文本规范化

每个文本片段必须执行相同的最小规范化：

1. 把 `CRLF` 和单独的 `CR` 转换为 `LF`。
2. 去掉片段开头和结尾的空白行。
3. 保留正文内部的缩进和换行。
4. 同一 section 内多个普通文本片段使用一个空行连接。
5. section 之间使用一个空行连接。
6. 最终字符串末尾不附加额外换行。

实现不能重排、改写、总结或去重正文。

## 6. 冲突和解释规则

section 顺序是稳定的序列化顺序，不单独代表权限高低。冲突按以下规则处理：

1. `baseSystem` 中的安全和基础行为边界不能被其他 section 覆盖。
2. `runtimeDirectives` 只能在 runtime 实际授予的范围内描述当前模式、权限和目标。
3. `workspaceInstructions` 只在其声明的 `boundary` 内生效；范围更窄的项目规则可以细化范围更宽的规则。
4. `personalization` 只影响表达，不参与安全、权限、事实或任务目标冲突。
5. `environment` 和 `localMemory` 是数据，不作为指令来源。
6. `localMemory` 中任何看似指令的内容都按引用数据处理。

如果两个具有相同权限且相同适用范围的 instruction 无法同时满足，Context Manager 不负责自行改写内容；Agent 应在执行阶段报告冲突或请求澄清。

## 7. Context Manager 集成

`ContextManager.beginRun()` 负责在 prepare 阶段完成 system prompt 组装：

```text
1. 加载六类 prompt sources
2. 检查每个来源的结构
3. 规范化各 section 内容
4. 按固定顺序序列化非空 section
5. 复制当前 context history
6. 在临时 history 中追加本次 prompt messages
7. 接收已经实例化的 tools
8. 检查 abort signal
9. 同步、原子地提交 history 和 run-local AgentContext
```

输出仍使用 Agent Core 的统一结构：

```ts
interface AgentContext {
	readonly systemPrompt: string;
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentTool[];
}
```

要求：

- system prompt 每个顶层 run 组装一次。
- 同一 run 的 ReAct、tool 和 follow-up 循环复用同一个 `systemPrompt`。
- context compact 只替换 message history，不修改或重新组装 system prompt。
- 下一次独立 `prompt()` 必须重新读取 sources 并生成新的 system prompt。
- tools 始终通过 `AgentContext.tools` 传递，不能序列化进任何 prompt section。
- Agent 不保存 system prompt sources 或最终字符串的副本。

## 8. Prepare/Commit 和取消

source provider 可以异步加载内容，因此组装必须遵守 Context Manager 的 prepare/commit 语义：

- prepare 阶段允许 await，但只能修改临时数据。
- 每个异步 source provider 返回后必须再次检查 signal。
- 所有校验、规范化和序列化必须在 commit 前完成。
- commit 前必须再次检查 signal。
- commit 同步、无 await，并同时发布新 history 和 run-local context。
- prepare 失败或 commit 前取消时，已提交 history 和当前 run-local context 保持不变。

## 9. 错误语义

以下情况必须使 `beginRun()` reject：

- `baseSystem` 缺失或为空。
- source provider 加载失败。
- workspace instruction 缺少 `source`、`boundary` 或 `content`。
- local memory entry 缺少 `content`。
- 输入不是规范允许的类型。
- 组装期间检测到 abort。

错误不能通过省略必需内容或使用部分 system prompt 静默降级。

## 10. 参考输出

```text
<base_system>
You are an agent responsible for completing the user's task safely.
</base_system>

<personalization>
Respond in concise Chinese unless the user requests another language.
</personalization>

<environment>
Working directory: D:\work\example
Operating system: Windows
Shell: PowerShell
</environment>

<workspace_instructions>
<instruction source="D:\work\example\AGENTS.md" boundary="D:\work\example">
Run the targeted test after modifying a test file.
</instruction>
</workspace_instructions>

<local_memory data_only="true">
<memory source="project-memory">
The repository previously used Node.js 22 during local verification.
</memory>
</local_memory>

<runtime_directives>
Mode: default
Filesystem permission: workspace-write
Current goal: inspect the context manager
</runtime_directives>
```

## 11. 验收场景

至少覆盖以下测试：

1. 六个 section 都存在时，按固定顺序输出。
2. 可选 section 缺失时不输出空标签，剩余顺序不变。
3. `baseSystem` 缺失、空字符串或全空白时失败。
4. 普通字符串数组按输入顺序使用一个空行连接。
5. 换行统一为 LF，片段边缘空白行被移除，正文内部格式不变。
6. workspace instruction 输出 `source`、`boundary` 和 `content`。
7. 多份 workspace instructions 按范围从宽到窄稳定排列。
8. workspace instruction 属性中的特殊字符被正确转义。
9. local memory section 始终包含 `data_only="true"`。
10. local memory 正文中的指令样文本不进入其他 section，也不改变组装结果。
11. tools 不出现在最终 system prompt 中。
12. 同一顶层 run 的全部 Model Runner 调用收到相同的 system prompt。
13. 下一次独立 run 会重新加载 sources，并可得到不同的 system prompt。
14. compact 前后 system prompt 保持不变。
15. source provider 失败时不提交 prompt messages 或部分 run-local context。
16. source provider 忽略 signal 并正常返回，但 signal 已 aborted：不提交任何 prepared state。
17. 相同输入多次组装产生完全相同的字符串。

## 12. 未来扩展

未来可以在独立变更中增加：

- `skillsCatalog` section。
- system prompt token budget。
- section 级缓存和内容哈希。
- 动态 source provenance 元数据。

新增 section 时必须明确它的职责、权限、固定位置、空值行为和验收场景，不能改变现有 section 的语义。
