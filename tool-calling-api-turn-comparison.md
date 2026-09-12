# 三种工具调用 API 的完整 Turn 对比

本文用同一个天气查询任务，对比以下三种 API 如何表达一次完整的工具调用流程：

1. Anthropic Messages API
2. OpenAI-compatible Chat Completions API
3. OpenAI Responses API

## 什么是一个完整的 Turn

本文把一个完整 turn 定义为：

```text
用户提出问题
  → 模型决定调用工具
  → 应用执行工具
  → 应用把工具结果返回模型
  → 模型生成最终回答
```

虽然用户只提问一次，但一次包含工具调用的 turn 通常需要两次模型 API 请求。

三个示例使用相同的问题：

```text
北京今天天气怎么样？
```

应用执行天气工具后得到：

```json
{
  "city": "北京",
  "temperature": 25,
  "condition": "晴"
}
```

自定义工具通常由应用执行。模型 API 返回的是结构化调用指令，不是工具的实际执行结果。

---

## 1. Anthropic Messages API

### 第一次请求：把用户问题和工具定义发给模型

```http
POST /v1/messages
```

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "get_weather",
      "description": "查询城市天气",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          }
        },
        "required": ["city"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "北京今天天气怎么样？"
    }
  ]
}
```

### 第一次响应：模型生成 `tool_use`

```json
{
  "role": "assistant",
  "stop_reason": "tool_use",
  "content": [
    {
      "type": "text",
      "text": "我来查询北京的天气。"
    },
    {
      "type": "tool_use",
      "id": "toolu_123",
      "name": "get_weather",
      "input": {
        "city": "北京"
      }
    }
  ]
}
```

应用读取 `name` 和 `input`，然后执行：

```text
get_weather({"city":"北京"})
```

### 第二次请求：通过 `tool_result` 返回工具结果

Anthropic Messages API 通常要求应用重传本轮消息历史。工具结果位于一条 `user` 消息中，但内容块的类型明确标记为 `tool_result`。

```http
POST /v1/messages
```

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "get_weather",
      "description": "查询城市天气",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          }
        },
        "required": ["city"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "北京今天天气怎么样？"
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "我来查询北京的天气。"
        },
        {
          "type": "tool_use",
          "id": "toolu_123",
          "name": "get_weather",
          "input": {
            "city": "北京"
          }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_123",
          "content": "{\"city\":\"北京\",\"temperature\":25,\"condition\":\"晴\"}"
        }
      ]
    }
  ]
}
```

### 最终响应

```json
{
  "role": "assistant",
  "stop_reason": "end_turn",
  "content": [
    {
      "type": "text",
      "text": "北京今天晴，气温约 25°C。"
    }
  ]
}
```

### 结构特点

```text
assistant.content[]
  ├─ text
  └─ tool_use

user.content[]
  └─ tool_result
```

工具调用和普通文本都是有序的 content block。工具输入 `input` 是 JSON 对象。

---

## 2. OpenAI-compatible Chat Completions API

GLM 当前公开的通用 OpenAI-compatible 接口主要采用这种格式；火山方舟／豆包也支持这种格式。

### 第一次请求：把用户问题和函数定义发给模型

```http
POST /v1/chat/completions
```

智谱 GLM 的实际接口示例：

```text
https://open.bigmodel.cn/api/paas/v4/chat/completions
```

```json
{
  "model": "glm-5.2",
  "messages": [
    {
      "role": "user",
      "content": "北京今天天气怎么样？"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {
              "type": "string"
            }
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

### 第一次响应：模型生成 `tool_calls`

```json
{
  "choices": [
    {
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"北京\"}"
            }
          }
        ]
      }
    }
  ]
}
```

`function.arguments` 是 JSON 字符串，应用需要解析后再调用函数：

```python
arguments = json.loads(tool_call.function.arguments)
```

### 第二次请求：通过 `role: "tool"` 返回工具结果

Chat Completions 通常要求应用重传消息历史，包括模型刚刚生成的 assistant 工具调用消息。

```http
POST /v1/chat/completions
```

```json
{
  "model": "glm-5.2",
  "messages": [
    {
      "role": "user",
      "content": "北京今天天气怎么样？"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_123",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"city\":\"北京\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_123",
      "content": "{\"city\":\"北京\",\"temperature\":25,\"condition\":\"晴\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {
              "type": "string"
            }
          },
          "required": ["city"]
        }
      }
    }
  ]
}
```

### 最终响应

```json
{
  "choices": [
    {
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "北京今天晴，气温约 25°C。"
      }
    }
  ]
}
```

### 结构特点

```text
assistant message
  └─ tool_calls[]

tool message
  ├─ role: "tool"
  └─ tool_call_id
```

工具调用位于 assistant 消息的独立 `tool_calls` 字段中，工具结果使用专门的 `tool` 角色。

---

## 3. OpenAI Responses API

OpenAI 和火山方舟／豆包目前均提供这种接口。火山方舟的实际接口为：

```text
https://ark.cn-beijing.volces.com/api/v3/responses
```

### 第一次请求：通过 `input` 发送问题

```http
POST /v1/responses
```

```json
{
  "model": "doubao-seed-2-0-lite-260215",
  "input": "北京今天天气怎么样？",
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "查询城市天气",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          }
        },
        "required": ["city"]
      }
    }
  ]
}
```

Responses API 的工具定义没有 Chat Completions 中间的 `function` 包装层。

### 第一次响应：`output` 中出现 `function_call`

```json
{
  "id": "resp_123",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "id": "fc_123",
      "type": "function_call",
      "status": "completed",
      "call_id": "call_123",
      "name": "get_weather",
      "arguments": "{\"city\":\"北京\"}"
    }
  ]
}
```

这里有两个不同的 ID：

- `id` 是这个 output item 自身的 ID。
- `call_id` 用来关联后续返回的工具结果。

### 第二次请求：通过 `function_call_output` 返回结果

使用 `previous_response_id` 关联上一轮响应时，不需要手动重传全部消息历史。

```http
POST /v1/responses
```

```json
{
  "model": "doubao-seed-2-0-lite-260215",
  "previous_response_id": "resp_123",
  "input": [
    {
      "type": "function_call_output",
      "call_id": "call_123",
      "output": "{\"city\":\"北京\",\"temperature\":25,\"condition\":\"晴\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "查询城市天气",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          }
        },
        "required": ["city"]
      }
    }
  ]
}
```

### 最终响应

```json
{
  "id": "resp_456",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "id": "msg_456",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "北京今天晴，气温约 25°C。"
        }
      ]
    }
  ]
}
```

### 结构特点

```text
response.output[]
  ├─ function_call
  └─ message
       └─ output_text

下一次 input[]
  └─ function_call_output
```

Responses API 把文本、工具调用等统一建模为 item，并可通过 `previous_response_id` 延续上下文。

---

## 核心字段映射

| 含义 | Anthropic Messages | Chat Completions | Responses API |
|---|---|---|---|
| 请求入口 | `/v1/messages` | `/v1/chat/completions` | `/v1/responses` |
| 对话输入 | `messages` | `messages` | `input` |
| 工具参数定义 | `input_schema` | `function.parameters` | `parameters` |
| 模型请求调用工具 | `tool_use` | `tool_calls[]` | `function_call` |
| 调用参数 | `input` 对象 | `arguments` 字符串 | `arguments` 字符串 |
| 调用关联 ID | `id` | `id` | `call_id` |
| 回传工具结果 | `tool_result` | `role: "tool"` | `function_call_output` |
| 结果关联字段 | `tool_use_id` | `tool_call_id` | `call_id` |
| 历史上下文 | 重传 `messages` | 重传 `messages` | 可用 `previous_response_id` |
| 最终文本 | `content[].text` | `choices[].message.content` | `output[].content[].text` |

## 快速识别方法

```text
看到 tool_use / tool_result
→ Anthropic Messages API

看到 choices + tool_calls + role: "tool"
→ Chat Completions API

看到 output[] + function_call + function_call_output
→ Responses API
```

## GLM 与豆包当前接口情况

截至 2026 年 9 月 12 日：

| 厂商 | Chat Completions | Responses API |
|---|---:|---:|
| 智谱 GLM 国内开放平台 | 支持 | 官方通用 API 中暂未发现支持 |
| 火山方舟／豆包 | 支持 | 支持 |

智谱公开的通用 OpenAPI 规范目前列出 `/paas/v4/chat/completions` 和 `/paas/v4/async/chat/completions`，没有列出通用的 `/responses` 路径。GLM-Realtime 中虽然也有 `function_call_output` 等同名概念，但它属于 WebSocket Realtime 事件协议，不等同于 HTTP Responses API。

“支持 Responses API”通常表示兼容其核心请求和数据结构，不应直接理解为支持 OpenAI Responses API 的全部内置工具、字段和行为。

## 参考资料

- [Anthropic：Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [OpenAI：Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [智谱：工具调用](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling)
- [智谱：HTTP API 调用](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)
- [火山方舟：Responses API 工具调用](https://www.volcengine.com/docs/82379/1958524?lang=zh)
