# 04 · 保存会话，并在退出后继续工作

[学习路线](README.md) · 上一章：[模型接口](03-providers.md) · 下一章：[上下文管理](05-context.md)

到这里，消息还可以只存在内存中。一旦程序关闭，模型做过什么、哪些工具执行成功、下一步应该做什么都会丢失。本章把这些过程变成可恢复的记录。

## 记录什么，怎样记录

mini-harness 使用 JSONL：每行一个 JSON 对象，每条新记录追加到文件末尾。文件位于 `MH_HOME/projects/<slug>/sessions/<id>/session.jsonl`，默认数据目录为 `~/.mh`。

| 记录类型      | 内容                                                 | 恢复时的用途           |
| ------------- | ---------------------------------------------------- | ---------------------- |
| `header`      | 版本、会话 ID、目录和创建时间                        | 确认这是什么会话       |
| `message`     | 用户、助手、工具结果                                 | 形成模型能看到的对话   |
| `compaction`  | 摘要、保留消息的起点                                 | 用摘要接上较新的消息   |
| `clearing`    | 被清理的工具结果 ID                                  | 恢复相同的占位内容     |
| `modelChange` | 切换后的模型与 provider                              | 恢复选择               |
| `trace`       | 最终用量、缓存报告状态与诊断、耗时、工具与 hook 状态 | 排查问题、统计评测指标 |

为什么把消息与 trace 分开？它们虽然写在同一文件中，用途不同。模型需要任务信息，开发者还需要知道执行用了多久、哪一步失败；恢复上下文时只取应进入对话的内容。

## 谁负责写文件

核心循环只发事件。应用层 [startRun](../../src/app/run.ts) 接到 `message` 就保存消息，接到 `toolEnd` 就保存工具统计，接到 `contextReplaced` 就保存清理或摘要记录。命令行层同时可以把事件显示出来。

[SessionStore](../../src/session/store.ts) 用同步追加写入，简化了本地单进程下的顺序管理。它没有事务数据库和同一会话的多写者协调；不能据此推断多个进程可以安全同时写同一个会话。

## 历史记录与当前上下文是两件事

假设文件保存了这些记录，下面只是顺序示意，省略了 JSON 字段：

```text
e1  用户：修复测试
e2  助手：读取文件
e3  工具：很长的源码
e4  用户：继续处理边界情况
e5  compaction：此前已经修复主路径；从 e4 开始保留
e6  助手：开始检查边界情况
```

恢复后，模型得到“e5 的摘要 → e4 → e6”。旧记录 e1～e3 仍然保留，便于追查，但不会每次重新发送。

[rebuild](../../src/session/rebuild.ts) 找到最后一次摘要，再根据 `firstKeptEntryId` 拼回后续消息，并把已清理的工具结果替换为占位文本。压缩过程和进程重启使用相同的恢复规则，才能避免“当时能继续，重启后却换了一份上下文”。

## 程序正好在工具执行中关闭怎么办

最棘手的情况是：助手的工具调用已经保存，但结果还没有保存。文件操作可能执行过，也可能没有执行，程序不能安全地猜。

`startRun` 在恢复消息后检查未配对的调用，补一条错误结果：“上次进程停止前未完成记录，请在需要时重新发出调用。”模型随后可以先查看文件或命令状态，再决定怎么继续。

这保留了协议所需的调用配对，也承认磁盘状态可能已经改变。恢复会话不会重放历史工具操作，更不能恢复已结束的进程。

文件结尾和损坏分开处理：

- 最后一条 JSON 完整，但末尾缺少换行：打开续接时只补一个换行，保留原记录字节；否则下次追加会把两条 JSON 粘在一起。列出会话时保持只读。
- 最后一行没有写完整：警告，保留并重新写回前面的有效记录。
- 中间记录损坏：报告文件和行号，不静默跳过未知内容。

## 怎样验证这一步

在项目根目录的 PowerShell 7 或 WSL Ubuntu bash 中执行：

```sh
node --import ./test/helpers/setup.ts --test test/unit/session/store.test.ts test/unit/session/render.test.ts test/integration/recovery.test.ts
```

重点看 `ignores truncated last line`、`errors on corrupt middle line with line number` 和 `resume repairs tool calls interrupted by a process crash`。后者先构造一个只有调用、没有结果的会话，再检查恢复请求是否含有对应的错误结果。

`resume appends safely after a valid final record without a newline` 覆盖另一种容易漏掉的情况：记录内容有效，缺的只是下一条记录之前的分隔符。

源码阅读顺序是 [session/types.ts](../../src/session/types.ts) → [store.ts](../../src/session/store.ts) → [rebuild.ts](../../src/session/rebuild.ts) → [app/run.ts](../../src/app/run.ts)。CLI 的 `-c` 和 `-r` 入口在 [main.ts](../../src/cli/main.ts)，它还会恢复上次 provider/model，并优先采用显式参数。

思考题：如果 write 已经成功，但结果还没落盘就退出了，直接自动重试所有未完成调用会有什么风险？读取当前状态为什么更稳妥？

下一章：[历史越来越长，怎样控制每次发送的内容](05-context.md)。
