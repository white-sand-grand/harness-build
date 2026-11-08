# 提示缓存：稳定前缀、最终用量与网关排查

[学习路线](learn/README.md) · [模型接口](learn/03-providers.md) · [上下文管理](learn/05-context.md) · [评测与指标](learn/08-evaluation.md)

这份指南沿着 mini-harness 的请求构造、流式解析和 trace，解释如何验证提示缓存。实现支持 GPT-6.1 Sol 的原生缓存参数，以及 Anthropic 兼容端点的缓存用量；每个模型和端点需要分别验收。

会话保存消息，应用层冻结组装后的系统提示，模型服务端保存可复用前缀的 KV 计算结果。这三种状态承担不同职责：有会话文件不保证服务端命中，`store: false` 也不表示关闭提示缓存。

## 核实依据

以下原厂资料的接口规则于 2026-11-08 核对，参数是否可用仍以实际端点为准：

- OpenAI 博客：[Why we built the Responses API](https://developers.openai.com/blog/responses-api)：保留加密推理和完整 output items，有助于多轮连续性与缓存复用。
- OpenAI：[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)：Sol 的可缓存前缀至少 1,024 个可见输入 token；支持显式断点、implicit 模式、30 分钟默认 TTL；变化内容放在稳定断点之后。
- OpenAI：[Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)：使用前次 response ID 请求比较，检查服务器给出的未命中原因。它只比较元数据，不会加载历史对话。
- OpenAI：[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls)：`store: false` 时完整回传 output items，Sol 可使用 `reasoning.context: all_turns`。
- Anthropic 博客：[Prompt caching with Claude](https://claude.com/resources/articles/prompt-caching)：区分缓存写入与读取费用，复用长期稳定背景和逐步增长的对话。具体参数按各厂商当前 API 文档实现。

旧版 OpenAI 模型的 `prompt_cache_retention: 24h` 和缓存 key 路由建议不能直接作为 Sol 的解决方案。当前官方文档说明 Sol 无需靠 cache key 优化路由；本项目不添加随机 key，也不主动发送收费预热请求。

## 先分清零命中和未报告

先检查端点是否返回了缓存用量。`cached_tokens: 0` 是明确报告的零读取；没有这个字段，只能说明客户端无法确认。缓存写入和读取也要分开：首次请求可以写入缓存而没有读取，某些兼容端点则可能把写入字段报告为 0。

官方端点默认可隐式缓存，缺少显式缓存参数本身不足以证明零命中的根因。兼容网关可能不支持新参数、改变请求、缺少计数字段或路由到未保存相同前缀的后端，需要用真实端点的响应核实。

## 请求怎样保留可复用前缀

Sol 及其快照默认使用：

1. 工具定义保持顺序和内容不变。
2. developer 的首个 `input_text` 放静态提示与项目指令，附 `prompt_cache_breakpoint: {"mode":"explicit"}`。
3. 按系统提示末尾的 Memory / Environment 段落边界，把记忆和环境放在后续文本块，保持原文和顺序。它们改变时，仍可复用之前已达到最小长度的稳定前缀。
4. `prompt_cache_options: {"mode":"implicit","ttl":"30m"}` 继续缓存逐步增长的对话。
5. `reasoning.context: "all_turns"`，原样回传加密推理、assistant phase 和工具调用结果。
6. 同模型前一条响应有 ID 时，设置 `comparison_response_id`；完整历史仍由客户端回传。

源码从 [systemCacheBoundary](../src/context/system-prompt.ts) 看起：上下文层计算稳定段结束的字符偏移，应用层经 `AgentConfig` / `ModelRequest` 传给 [buildOpenAIBody](../src/ai/openai.ts)。这样模型适配器只处理协议和偏移，不依赖应用层的段落格式。

短提示首次读缓存为 0 是正常情况。断点前的可复用内容必须达到服务端最小长度；不会为了跨过阈值填充无用文字。压缩、清理旧工具输出、切换模型或修改工具定义可能有意改变前缀，不能承诺这些操作后仍复用完整缓存。

## 网关兼容

如果网关以 HTTP 400 明确拒绝缓存扩展字段，客户端仅移除这些扩展，再请求同一个 `/v1/responses` 一次。本 provider 实例后续沿用兼容方式；trace 标记 `compatibilityFallback`。一般 HTTP 400、鉴权失败、网络错误和已开始的 SSE 不触发此兼容重试。

对于已知不支持这些字段的网关，可在项目或全局配置中关闭扩展：

```json
{
  "models": {
    "gpt-6.1-sol": {
      "provider": "openai",
      "compat": { "promptCache": false }
    }
  }
}
```

这会使用兼容 Responses 请求形状；实际隐式缓存仍取决于网关，不表示强制关闭服务端缓存。不要把密钥放进配置文件。

## 计数与诊断

Responses 的普通输入量按 `input_tokens - cached_tokens - cache_write_tokens` 计算，防止重复计算。统一的 `cacheRead` 和 `cacheWrite` 分别记录服务端真实读写量；端点缺少字段时保留“未报告”状态，CLI 显示 `n/a`。

```sh
mh trace latest --json
```

查看 `usage.cacheRead`、`usage.cacheWrite`、`cache.readReported`、`cache.writeReported`、`cache.hitRate` 和 `cache.misses`。逐轮原生诊断与响应 ID 保存在会话 JSONL 的 turn trace；例如 `input_changed`、`tools_changed`、`reasoning_effort_changed`。压缩摘要和 judge 的缓存元数据也进入 trace。

缺少诊断不等于缓存正常或关闭；网关可能没有透传该字段。旧 JSONL 没有报告状态时，0 次读取不足以证明端点确实报告了零命中，因此汇总可能显示未知。

## 真实网关验收

Windows PowerShell 中给当前进程设置 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 后运行：

```powershell
$env:MH_LIVE = '1'
$env:MH_LIVE_CACHE = '1'
node --test test/live/cache.test.ts
```

WSL Ubuntu：

```sh
MH_LIVE=1 MH_LIVE_CACHE=1 node --test test/live/cache.test.ts
```

该测试固定使用用户指定的 `gpt-6.1-sol`，以项目 README 作为真实参考材料，顺序发出两次请求并输出缓存读写与诊断。它会产生 API 费用；第二次没有报告缓存读取或确实仍为零时，测试失败并保留相应证据，不将缺失字段当作成功。

## 阶跃真实验证（2026-11-08）

这是一次原生 Windows Node 的验证样例，模型为 `step-5-preview`，Anthropic 兼容端点为 `https://api.stepfun.com/step_plan/v1/messages`。实验使用项目 README 作为参考材料，前面放入一次生成、三次请求均保持不变的实验 ID；前两次请求完全相同，第三次追加 assistant 和 user 消息。

以流结束时的最终 usage 为准，本次结果为：

| 请求     | 普通输入 token | 读取缓存 token | 写入缓存 token | 输入缓存命中率 |
| -------- | -------------: | -------------: | -------------: | -------------: |
| 首次请求 |           6849 |              0 |              0 |             0% |
| 相同请求 |            449 |           6400 |              0 |          93.4% |
| 追加对话 |            540 |           6400 |              0 |          92.2% |

写入字段为 0 是该次接口的实际报告，后两次读取 6400 token 证实已经使用缓存。该结果验证阶跃链路；GPT-6.1 Sol 兼容网关仍需使用上一节的单独验收入口。

验证也发现并修复了统计偏差：阶跃 `message_start` 的缓存数是初始估计，最终 `message_delta.usage` 可能修正输入和缓存数，甚至把初始命中修正为 0。适配器现在按最终实际出现的字段覆盖，保留终态没有提供的旧字段；终态的 0 不会被丢弃。中间增量携带的计数不会重复累加。

复跑时，在独立进程为阶跃配置 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，然后在 Windows PowerShell 执行：

```powershell
$env:MH_LIVE = '1'
$env:MH_LIVE_STEP_CACHE = '1'
node --test test/live/step-cache.test.ts
```

测试要求第二次及追加对话后的最终缓存读取均大于 0，并打印每次最终用量。具体计数随参考材料、模型和服务端状态变化；表中数值是一次实测，不是后续运行的固定断言。原始运行记录、会话和完整工具输出属于本地数据，由 [.gitignore](../.gitignore) 排除。
