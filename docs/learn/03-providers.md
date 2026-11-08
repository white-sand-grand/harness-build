# 03 · 把不同模型协议接到相同循环

[学习路线](README.md) · 上一章：[工具与执行边界](02-tools.md) · 下一章：[会话与恢复](04-sessions.md)

第一章用固定回复替代了模型。接入真实服务后，循环仍然只关心“收到文字还是工具调用”，协议转换交给 provider，也就是模型接口适配器。

## 先定义程序真正需要的接口

[Provider](../../src/ai/types.ts) 的核心方法是：

```ts
stream(request, signal, onEvent): Promise<AssistantMessage>
```

这是接口示意：输入包含模型信息、系统提示、消息和工具定义；运行中通过 `onEvent` 发送文字或工具参数片段；结束后返回完整消息、停止原因和用量。`signal` 从外层传入，用于中断。

流式片段用于显示进度。工具执行使用最终整理好的调用，而不会在参数 JSON 只到一半时开始操作文件。

## 为什么不能只统一成一串聊天文字

工具调用有 ID 和结构，推理内容也可能带着后续请求必须原样回传的数据。只保留可见文本，会丢失这些信息。

| 内部内容           | OpenAI Responses                                            | Anthropic Messages                     |
| ------------------ | ----------------------------------------------------------- | -------------------------------------- |
| 系统提示           | `instructions`，或支持缓存断点的 developer 内容块           | `system`                               |
| 用户和助手消息     | `input` 中的消息或原生 output items                         | `messages` 的 content blocks           |
| 工具定义           | 扁平的 function tools                                       | 带 `input_schema` 的 tools             |
| 工具调用/结果      | `function_call` / `function_call_output`，按 `call_id` 配对 | `tool_use` / `tool_result`，按 ID 配对 |
| 需要保留的原生数据 | 原生 output items，包括加密推理                             | thinking 块及其 signature              |

当前 OpenAI 适配器只请求 `/v1/responses`，使用 `store: false`，由客户端保存并回传状态。Anthropic 适配器请求 `/v1/messages`，会合并连续工具结果，并在系统、工具和最近用户内容上设置缓存标记。

对于 `gpt-6.1-sol`，OpenAI 适配器还会把稳定指令放进带缓存断点的 developer 内容块，将记忆和环境放在后面，并保留缓存读写、是否报告计数及未命中诊断。兼容网关明确不支持新参数时重试兼容 Responses，细节见[提示缓存设计](../prompt-caching.md)。

统一接口让内核独立于协议；保存原生字段则承认协议之间存在差异。切换 provider 时，并不保证所有私有推理状态可以无损迁移。

## 一次流式响应怎样变成完整消息

```text
HTTP 字节块
  → TextDecoder 还原跨块的 UTF-8
  → 按空行切分 SSE 事件，合并多行 data
  → 适配器识别文字、工具参数、用量和结束事件
  → 发送显示事件，并组装 AssistantMessage
```

[SSE 解析器](../../src/ai/sse.ts)只处理传输格式，不判断某个事件代表工具还是文字。两种适配器分别解释自己协议的事件。

例如，一个汉字的字节可能分在两个网络块中，不能对每一块独立解码；工具参数也会分多次到达，需要按所属调用累积，最后再解析 JSON。OpenAI 适配器还会检查是否收到有效结束事件，避免把突然断流误认为成功完成。

## 为什么用量要读到响应结束

流开始时的统计可能只是估计。阶跃的 Anthropic 兼容接口曾在 `message_start` 报告缓存读取 6812 token，最终 `message_delta.usage` 却修正为 0；如果只保留开头的数据，就会把首次请求误报成命中。

[AnthropicProvider](../../src/ai/anthropic.ts) 的 `updateUsage` 按字段更新累计值：最终出现的字段覆盖旧值，缺失字段继续保留。这里使用 `??`，因此有效的 0 能覆盖初始估计；中间增量上的重复计数不累加。OpenAI 则读取 Responses 结束事件的用量。

内部 `Usage.input` 表示普通输入，`cacheRead` 和 `cacheWrite` 分开记录。Responses 的 `input_tokens` 包含缓存读写，因此需要先扣除两者，再与普通输入相加计算总量；Anthropic 的字段按其协议直接映射。端点没有报告缓存字段时，`cache.readReported` / `writeReported` 为 false，界面显示 `n/a`。

## 出错之后什么时候重试

| 情况                                             | 行为                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| 429、部分服务端错误或网络错误，尚未收到 SSE 事件 | 最多自动重试 3 次，指数退避；有 `Retry-After` 时按有上限的等待处理 |
| 网关以 HTTP 400 明确拒绝 Sol 缓存扩展            | 去掉扩展后重试同一 Responses 端点一次，并记录兼容处理              |
| 已收到 SSE 事件后失败                            | 返回错误，不自动重发整次请求                                       |
| 用户中断                                         | 返回 `aborted`，保留已完成的部分内容                               |
| API 或网络失败                                   | 转成 `stopReason: error` 和可读错误信息                            |
| 编程错误                                         | 可以抛异常，由应用层记录异常结束                                   |

收到事件后不自动重发，能避免把两次生成混在一起，也减少重复生成和额外费用。但“客户端尚未收到事件”不意味着服务端一定没有开始处理，因此重试仍不保证只发生一次服务端执行。

用量从服务响应读取；价格未知时费用显示 `n/a`。模型窗口和能力有配置回退值，它们是客户端假设，需要按实际端点覆盖。

## 源码阅读顺序

1. [ai/types.ts](../../src/ai/types.ts)：看内部接口、`responsesOutput`、`responsesId` 和 `cache`。
2. [openai.ts](../../src/ai/openai.ts) 的 `buildOpenAIBody`、[anthropic.ts](../../src/ai/anthropic.ts) 的 `buildAnthropicBody`：先看发出的请求。
3. [sse.ts](../../src/ai/sse.ts) 和两个 `stream` 实现：再看返回内容怎样还原。
4. [retry.ts](../../src/ai/retry.ts)、[shared.ts](../../src/ai/shared.ts)：看重试条件和地址补齐。

## 怎样验证这一步

在项目根目录的 PowerShell 7 或 WSL Ubuntu bash 中执行：

```sh
node --import ./test/helpers/setup.ts --test test/unit/ai/sse.test.ts test/unit/ai/providers.test.ts test/unit/ai/responses.test.ts test/unit/ai/cache.test.ts test/unit/ai/endpoints.test.ts
```

这些测试通过本地服务拆分字节和事件，验证中文跨块、参数累积、服务端错误重试及断流。重点看 Responses 的 `replays opaque reasoning and call_id across Responses turns` 与 `Responses transport truncation does not return false success`。

离线协议测试可以稳定重现边界，真实端点是否兼容仍需单独验证。[README 的真实模型测试说明](../../README.md#开发与验证)提供了入口。

思考题：既然设置了 `store: false`，第二次请求只发送新工具结果，为什么可能缺少必要上下文？对照 `buildOpenAIBody` 看它如何重放历史。

下一章：[保存消息，并在退出后重建工作状态](04-sessions.md)。
