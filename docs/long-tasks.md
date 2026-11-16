# 长任务的上下文与交接

例如，迁移任务改了三个模块后达到轮次预算。下一轮应能找到原始目标、失败检查和已修改文件；模型说“完成”并不代表检查通过。mini-harness 用会话原始记录保存执行事实，用有界摘要保留工作线索，再用宿主运行的检查决定任务是否验证完成。

## 上下文预算与摘要

请求前先准备一次动态召回，再估算本次 system、工具说明与 schema、消息及协议开销，同时预留输出和安全余量。可比较的上一轮 provider usage 用于修正估算；压缩或系统内容变化后重新估算，避免重复计算旧 system/tools。

估算按 UTF-8 字节近似，图片和保留的 native Responses 输出也计入。它不是精确 tokenizer；实际端点溢出仍有一次有界恢复。配置较小窗口时应同步设置 `models.<id>.maxOutputTokens`。系统/工具/近期完整批次连同输出预留都放不下时，会明确停止，避免无效重试。

默认仍在窗口 60% 清理旧工具正文、80% 尝试摘要；预留不足时可以更早处理。清理足以降低上下文时优先清理。输出保存为与结果 entry 绑定的文件，保留原始 JSONL 和读取位置；重新查阅输出不需要重跑有副作用的命令。重复 tool call ID 不覆盖先前的输出文件。

默认摘要返回有界 `ContinuationSummaryV1`：目标、决策、未解决事项、下一步和来源 entry ID。宿主校验结构与来源范围，并补充原始用户条目引用、有限摘录及成功 write/edit 的文件索引。摘要格式有效不等于事实全部正确，必要时仍应查阅原始记录。自定义旧摘要模板与既有文本会话继续可读。

摘要必须完整结束且不调用工具。截断、错误、空文本和非法引用不会替换上下文；相关用量照实记录。原始审批消费和副作用判断始终依据原始记录。

## Ralph 的交接点

在项目根目录，使用 **WSL Ubuntu** 或 **Windows PowerShell 7**：

```sh
mh ralph '完成迁移并保留现有接口' --check 'node --test' --max-iter 3
```

输出包含 `Checkpoint session`。程序正常退出后，可以继续同一任务：

```sh
mh ralph --resume <checkpoint-session> --check 'node --test' --max-iter 3
```

每次调用的 `max-iter` 限制本次最多推进多少轮，累计轮数保留在交接点。每轮使用新会话；中断在某轮内部时，先通过原有 durable journal 恢复这一轮，已保存的结果不重放。进程异常退出留下 ownership 锁时，仍需按原有恢复流程确认旧进程及后代已停止；resume 不自动抢锁。

交接点绑定原目标、检查命令、运行配置和已加载的实现版本。恢复时仍需显式提供相同 `--check`。更换目标、检查、配置或实现应启动新任务。Markdown 进度可由模型更新；宿主控制的 revision、检查输出与结果单独保存，普通 write/edit 不能修改这些文件。

当前只为整体目标记录一个检查事项，没有逐功能独立检查时，不会宣称每项功能都通过。工作区指纹包含普通文件内容、未跟踪文件和符号链接身份；忽略 `.git`、`node_modules` 和运行数据 home，设有文件数和大小上限。因此它是工作区证据，不是对依赖内容或操作系统的完整快照。

用户改动文件后，旧的 passed 不再直接采用。恢复先运行原检查：手工修好即可结束，无须再请求模型。检查通过但生成了文件时，最多再运行一次检查确认状态稳定；仍持续改变文件则结果为 unknown。模型结束原因、检查结果与任务完成分别记录。

如果某次写入可能已经生效但结果未保存，恢复会要求 `needs_reconciliation`，不能把它当成普通可重试错误。准确审批仍走原有持久审批入口。Ralph 不自动执行 Git 提交，也没有新增后台任意编码权限。宿主文件限制属于现有防误操作护栏，任意 shell 的隔离边界没有改变。

## 验证

离线测试覆盖完整请求预算、截断/非法摘要、重复调用 ID 的输出恢复、交接点损坏、手工修改后的复查和未记录副作用。真实模型验证使用单独的 live runner 与独立结果检查；一次成功只能证明这次配置下的机制和任务结果，不能单独证明稳定性或优化收益。

本次[Step 大任务报告](reports/long-task-step-validation.md)保留了失败：最终复查 53/93，真实模型验收尚未通过。

参考：[Anthropic 长任务 harness](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)、[上下文工程](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)、[Pi compaction](https://github.com/earendil-works/pi/blob/747c217b81980206063a89e46645b362de7ac8b1/packages/coding-agent/src/core/compaction/compaction.ts)。
