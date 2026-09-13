# Codex Local Summary 压缩的触发条件

> 源码基线：Codex CLI `0.151.0`，Git tag `rust-v0.151.0`，commit `78c290807ce710180111df227df3b7a4fe845452`。

## 结论

Codex 是否需要压缩，以及压缩时采用 Local Summary 还是 Remote Compaction，是两个独立判断：

1. 先根据手动命令、token 使用量、模型切换等条件判断是否触发压缩。
2. 压缩触发后，再根据模型 provider 的能力选择具体实现。

当 `TokenBudget` 功能没有接管压缩，并且 provider 返回：

```rust
RemoteCompactionSupport::Unsupported
```

Codex 才进入这里讨论的 Local Summary 路径。

“Local”不表示完全离线，也不表示在本机运行总结模型。它表示 Codex 客户端自己构造总结提示词，调用普通模型生成文本摘要，而不是调用服务端 `/responses/compact` 接口。

## Local Summary 的具体压缩 Prompt

Codex CLI `0.151.0` 的默认 Local Summary prompt 是：

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

源码：[`prompts/templates/compact/prompt.md`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/prompts/templates/compact/prompt.md)。

运行时优先使用配置中的 `compact_prompt`；没有配置时才使用上面的 `SUMMARIZATION_PROMPT`：

```rust
let prompt = turn_context
    .config
    .compact_prompt
    .as_deref()
    .unwrap_or(SUMMARIZATION_PROMPT)
    .to_string();
```

源码：[`compact.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/compact.rs#L116-L133)。

## System prompt 是否参与摘要生成

参与。默认 Local Summary 的实际输入可以概括为：

```text
当前会话的 base/system instructions
    +
原 active history H
    +
作为最后一条 role=user 消息追加的 compaction prompt
```

压缩 prompt 本身不是 system prompt。Codex 先复制当前历史，再把压缩 prompt 转换成一条合成的用户消息追加到临时历史：

```rust
let mut history = sess.clone_history().await;
history.record_items(
    &[initial_input_for_turn.into()],
    turn_context.model_info().truncation_policy.into(),
);
```

随后构造普通模型请求时，仍然显式带上当前会话的 base instructions：

```rust
let prompt = Prompt {
    input: history
        .clone()
        .for_prompt(&turn_context.model_info().input_modalities),
    base_instructions: sess.get_base_instructions().await,
    ..Default::default()
};
```

源码：[`compact.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/compact.rs#L245-L294)。

在普通 Responses 模式中，`base_instructions.text` 被放进请求的 `instructions` 字段；历史和末尾的压缩 prompt 则放进 `input`：

```json
{
  "model": "当前会话模型",
  "instructions": "<当前 Codex base/system instructions>",
  "input": [
    "<规范化后的原历史 H>",
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "<CONTEXT CHECKPOINT COMPACTION prompt>"
        }
      ]
    }
  ],
  "tools": []
}
```

如果模型使用 Responses Lite，`instructions` 字段会留空，但相同的 base instructions 会被转换成一条置于 `input` 开头的 `role=developer` 消息。因此两条路径下 system/base instructions 都会参与摘要生成。

原历史中已经存在的 developer context，例如项目指令、环境上下文和其他运行时约束，也随临时历史 `H'` 一起发送。原始 `role=system` 历史消息通常不会作为普通历史 item 保存；Codex 主要通过独立的 `base_instructions` 维护系统级指令。

请求仍使用当前 `turn_context` 的模型和 reasoning 配置。由于这里只设置了 `input` 和 `base_instructions`，`Prompt` 的工具列表使用默认空值，摘要模型不能在这次调用中发起普通工具调用。

请求组装源码：[`client.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/client.rs#L919-L1010)。OpenAI Responses API 对 `instructions` 的定义见 [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)。

## 触发条件总览

| 场景 | 是否触发 | 发生时间 |
| --- | --- | --- |
| 用户执行 `/compact` | 是，无需达到 token 阈值 | 独立的 compact task |
| 新一轮开始时 token 达到阈值 | 是 | 正常模型采样前 |
| 一轮中仍需继续推理，且 token 达到阈值 | 是 | 工具调用或 pending input 之后 |
| 模型请求新的 context window | 是，但只有仍需继续推理时才执行 | 当前轮中间 |
| 切换模型且 `comp_hash` 改变 | 是 | 新模型首次采样前 |
| 切换到更小模型，旧历史放不进新窗口 | 是 | 新模型首次采样前 |
| 普通请求返回 `ContextWindowExceeded` | 当前失败轮不立即压缩；下一次模型调用前触发 | 下一轮开始前 |
| token 超过阈值，但当前轮已经结束 | 不立即压缩 | 下一轮开始前再压缩 |

## 1. 手动执行 `/compact`

用户执行 `/compact` 后，客户端产生：

```rust
Op::Compact
```

随后启动 `CompactTask`。手动压缩不检查 token 使用量，因此无论当前上下文多大都可以触发。

当 provider 不支持 Remote Compaction 时，任务进入 Local Summary：

```rust
RemoteCompactionSupport::Unsupported => {
    let input = vec![UserInput::Text {
        text: ctx
            .config
            .compact_prompt
            .as_deref()
            .unwrap_or(crate::compact::SUMMARIZATION_PROMPT)
            .to_string(),
        text_elements: Vec::new(),
    }];

    crate::compact::run_compact_task(session.clone(), ctx, input).await
}
```

源码：[`tasks/compact.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/tasks/compact.rs#L41-L77)、[`session/handlers.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/handlers.rs#L236-L241)。

## 2. 新一轮开始前达到 token 阈值

每次正常模型采样开始前，Codex 都会计算当前上下文的 token 状态：

```rust
let token_status =
    context_window_token_status(sess.as_ref(), turn_context.as_ref()).await;

if token_status.token_limit_reached {
    run_auto_compact(...).await?;
}
```

因此，如果上一轮结束时已经超过自动压缩阈值，Codex 不一定立即压缩，而是在用户下一次发消息、模型即将再次运行之前压缩。

源码：[`session/turn.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/turn.rs#L1032-L1061)。

## 3. 当前轮中间达到阈值

一次模型采样结束后，Codex 会检查当前轮是否还需要继续：

```rust
let needs_follow_up = model_needs_follow_up || has_pending_input;

let should_roll_over = needs_follow_up
    && (sess.take_new_context_window_request().await
        || token_limit_reached);
```

`needs_follow_up` 常见于：

- 模型刚调用了工具，需要把工具结果送回模型继续推理；
- 当前轮收到了新的 pending input；
- 当前任务还有下一次模型采样。

只有“还需要继续采样”并且“达到 token 阈值或请求了新 context window”时，Codex 才会在当前轮中途压缩。

如果模型已经输出最终回答，不需要继续采样，即使此时刚超过阈值，也不会马上压缩；压缩会推迟到下一次模型调用开始前。

源码：[`session/turn.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/turn.rs#L414-L500)。

## 4. 自动压缩阈值如何计算

核心判断是：

```rust
let token_limit_reached = buffered_auto_compact_limit
    .is_some_and(|limit| auto_compact_scope_tokens >= limit)
    || full_context_window_limit_reached;
```

可以简化为：

```text
token_limit_reached =
    作用域内 token >= 自动压缩阈值 + fallback buffer
    OR
    完整 active context token >= 模型可用上下文上限
```

### 自动压缩阈值

如果模型没有指定 `auto_compact_token_limit`，默认使用原始 context window 的 90%：

```rust
context_window * 9 / 10
```

如果用户或模型配置显式指定了阈值，则使用：

```text
min(配置阈值, context_window × 90%)
```

例如，原始 context window 为 200,000 tokens：

```text
默认自动压缩阈值 = 180,000 tokens
默认模型可用上限 = 190,000 tokens（200,000 × 95%）
```

通常会先到达 90% 的自动压缩阈值，从而在真正填满模型可用窗口前触发压缩。

源码：[`openai_models.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/protocol/src/openai_models.rs#L492-L510)、[`context_window.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/context_window.rs#L53-L89)。

### token 统计作用域

配置项 `model_auto_compact_token_limit_scope` 决定哪些 token 计入自动压缩阈值：

```rust
pub enum AutoCompactTokenLimitScope {
    Total,
    BodyAfterPrefix,
}
```

- `Total`：计算完整 active context，默认值。
- `BodyAfterPrefix`：只计算当前 compaction window 的固定前缀之后新增的 token。

即使使用 `BodyAfterPrefix`，完整上下文仍不能超过模型的可用 context window；后者始终是硬限制。

源码：[`config_types.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/protocol/src/config_types.rs#L42-L55)、[`context_window.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/context_window.rs#L23-L63)。

### token 数据从哪里来

当前 token 使用量不是单纯把所有字符串重新 tokenize。Codex 组合使用：

1. 最近一次服务端返回的 token usage；
2. 最近一次模型输出之后新增 item 的本地估算；
3. 必要时补入没有由服务端统计的历史 reasoning token。

源码：[`history.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/context_manager/history.rs#L429-L447)。

## 5. 切换模型时触发压缩

### `comp_hash` 改变

模型元数据中可以包含 `comp_hash`，它表示压缩上下文的兼容性标识。如果前后两个模型都声明了 `comp_hash`，且值不同：

```rust
previous.comp_hash != current.comp_hash
```

Codex 会在新模型第一次采样前触发压缩。这个条件与 token 使用量无关。

### 切换到更小的上下文窗口

如果同时满足以下条件，也会预先压缩：

```text
旧模型与新模型不同
AND
旧模型 context window > 新模型 context window
AND
当前 active context 已超过新模型的自动压缩阈值或可用窗口
```

为了减少模型切换造成的摘要漂移，Codex 优先尝试使用旧模型完成这次压缩，然后再使用新模型继续任务。

源码：[`session/turn.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/turn.rs#L1064-L1191)。

## 6. `ContextWindowExceeded` 的处理

普通模型请求如果已经返回：

```rust
CodexErrorDetails::ContextWindowExceeded
```

Codex 会把当前 token usage 标记成上下文已满：

```rust
sess.set_total_tokens_full(&turn_context).await;
```

当前失败轮不会立即执行“压缩后自动重试”；它会结束并向用户报告错误。下一次模型调用开始时，预采样检查会看到 `token_limit_reached = true`，从而触发压缩。

源码：[`session/turn.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/turn.rs#L1410-L1430)。

Local Summary 自己在生成摘要时也可能遇到 `ContextWindowExceeded`。此时它会删除临时历史中最旧的 item 后重试。这是压缩任务已经启动之后的容错逻辑，不是一个新的触发入口。

源码：[`compact.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/compact.rs#L300-L350)。

## Local/Remote 路径选择

自动压缩被触发后，Codex 才选择实现：

```rust
match turn_context.provider.capabilities().remote_compaction {
    RemoteCompactionSupport::V2 if remote_v2_enabled => {
        // Remote Compaction V2
    }
    RemoteCompactionSupport::V2 => {
        // Remote Compaction
    }
    RemoteCompactionSupport::Unsupported => {
        // Local Summary
        run_inline_auto_compact_task(...).await?;
    }
}
```

源码：[`session/turn.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/turn.rs#L1199-L1278)。

因此，Local Summary 和 Remote Compaction 的大部分自动触发条件是相同的；主要差别在于压缩任务如何执行，以及压缩结果采用文本摘要还是服务端 compaction item。

## `TokenBudget` 功能的例外

在 `run_auto_compact` 中，`TokenBudget` 功能的优先级高于 Local/Remote provider 分派：

```rust
if turn_context.config.features.enabled(Feature::TokenBudget) {
    run_inline_auto_compact_task(...).await?;
    return Ok(());
}
```

因此启用该功能时，压缩会进入新的 context-window/token-budget 管线，而不是本文主要分析的传统 Local Summary 分支。

## 完整流程

```text
手动 /compact
    │
    └──────────────────────────────┐
                                   │
正常模型调用                       │
    │                              │
    ├─ 请求前 token 达到阈值       │
    ├─ 当前轮需继续 + token 达阈值 │
    ├─ 请求新的 context window     │
    ├─ comp_hash 改变              │
    └─ 切换到更小模型且历史放不下  │
                                   │
                                   ▼
                              触发压缩
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
          provider 支持 remote             provider 不支持 remote
                    │                             │
                    ▼                             ▼
          Remote Compaction                Local Summary
```

## 官方 OpenAI API 对照

官方 OpenAI Responses API 提供 `context_management` 和 `compact_threshold` 参数，用于服务端上下文管理。Codex `0.151.0` 的 Local Summary 路径不依赖服务端自动阈值，而是由客户端的 `model_auto_compact_token_limit`、模型元数据以及上述 turn 调度逻辑控制。

- [Create a model response — OpenAI API Reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Compact conversation — OpenAI API Reference](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)
