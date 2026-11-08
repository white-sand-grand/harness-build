# 08 · 用任务结果检验设计与改进

[学习路线](README.md) · 上一章：[项目记忆](07-memory.md)

前面各章的测试回答“程序在给定条件下是否按设计行动”。评测再问一个问题：“模型使用这套程序后，有没有把任务做成？”

## 把任务定义成可检查的结果

一个评测任务包含初始文件、用户要求，以及结束后执行的检查命令。以 [fix-off-by-one](../../evals/tasks/fix-off-by-one/task.json) 为例：源码的循环漏掉了最后一个元素，任务要求修复并验证，检查通过 `node --test` 执行。

这种设计允许模型自由选择读取和修改顺序，只检查最终文件是否符合要求。优点是不把某一条工具轨迹当成唯一正确答案；局限是检查覆盖不到的错误仍然可能漏掉。

解释类任务可以加模型评分，即 judge。它根据任务、评分标准、代码 diff 和最终回复返回分数、是否通过及理由。配置了 judge 时，命令检查与评分都要通过；评分失败或无法解析也会让该次任务失败。

## 一次尝试如何保持独立

```text
复制任务文件到独立工作区
  → 创建 Git 初始快照，运行可选 setup
  → 使用独立 home、会话和提示词快照运行 agent
  → 运行任务检查，按需请求 judge
  → 保存结果、执行记录和工作区
```

[runEval](../../src/eval/runner.ts) 把任务与重复次数展开成队列，通过 worker 并发领取。所有运行显式传递 `cwd`、`home`，不改进程全局目录，避免一个任务写入另一个任务的工作区。

仅隔离主循环的 `home` 还不够：setup、工具、hooks、检查和 Git 子进程都要收到该次尝试的 `MH_HOME`。否则工具里嵌套调用 `mh` 时，仍可能使用外层的数据目录。实现给每个子进程传入自己的环境，不改共享的 `process.env`。

这里提供的是目录和应用状态隔离。子进程仍然运行在同一台机器上，共用外部环境和资源。

## 看懂结果，而不是只看一个百分比

| 结果           | 当前含义                                           |
| -------------- | -------------------------------------------------- |
| `pass`         | 结束检查退出 0、未超时且未中断；若有 judge，也通过 |
| `fail`         | 检查不通过，或评分失败                             |
| `setupError`   | 任务可选 setup 命令失败，agent 尚未开始            |
| `harnessError` | 准备或执行过程中抛出异常，例如 Git 初始化失败      |
| `endReason`    | 单独记录 agent 是正常结束、出错、中断还是轮数耗尽  |

注意：当前 `pass` 主要由最终检查决定，`endReason` 独立保存。因此模型接口返回错误后，只要最终文件已经满足检查，也可能同时出现 `status: pass` 和 `endReason: error`。分析时应一起看，不能把通过率等同于无执行故障率。

结果目录中的几个文件分别承担不同用途：

- `run.json`：任务清单、模型 ID、变体名和时间。
- `prompts/`：本次使用的提示词快照。
- `results.jsonl`：每次尝试的状态、用量、耗时、工具统计和会话路径。
- `summary.md`：汇总结果；工作区和会话保留，便于复查。

现有清单还没有完整保存代码版本、有效配置和端点信息；比较器也不会强制检查两组实验条件一致。复现实验时需要自行记录这些条件，这也是后续实验能力可以补强的部分。

## 缓存指标也要有可核对的含义

`mh trace latest --json` 汇总最终用量，并提供 `cache.readReported`、`writeReported`、`hitRate` 和未命中原因计数。命中率是缓存读取 token 除以全部输入 token；写入量单独记录。缺少报告显示未知，真正报告的 0 才表示零命中。

缓存的独立验证可以先发送两次完全相同的请求，再追加一轮对话，避免同时修改模型、工具和提示内容。项目的[阶跃缓存测试](../../test/live/step-cache.test.ts)按这个顺序运行；它曾发现流开始时的估计和结束时的最终缓存数不同，推动了第三章的用量解析修正。

这类验证证明指定模型与端点在该次运行中复用了输入，不证明代码任务更容易完成。缓存率、最终任务检查、工具错误和模型结束原因需要分别观察；模型接口没有透传诊断时，也不能据此猜测服务端未命中的原因。配置和运行步骤见[排查指南](../prompt-caching.md)。

## 开发任务与保留任务怎样分工

8 个种子任务分为 5 个 dev 和 3 个 heldout。Dev 用于发现问题和修改提示词，heldout 用于观察这些修改在另一组任务上的表现。

[analyzeRun](../../src/eval/analyze.ts) 只把 dev 的失败结果和对应会话提供给分析过程，复制当次提示词到临时目录；模型只能 read/write/edit，最终生成 `analysis.md` 和独立候选提示词。默认提示词不被覆盖，没有 dev 失败时直接复制并说明无需修改。

Heldout 的独立性由分析流程维护，不是秘密题库：任务源码在公开仓库中，使用者仍需避免针对其失败反复调参。保留任务被反复用于指导修改后，就应增加新的任务来独立检验。

## 怎样运行和理解一次改进流程

离线验证在项目根目录的 PowerShell 7 或 WSL Ubuntu bash 中执行，不需要密钥：

```sh
node --import ./test/helpers/setup.ts --test test/unit/eval/eval.test.ts
node scripts/validate-tasks.ts
```

第一条检查独立工作区、子进程 `MH_HOME`、结果统计、dev 筛选和候选输出。并发隔离用例还会在工具中启动嵌套 CLI，验证它使用各自的记忆目录。第二条在临时副本中验证初始任务和参考修改的检查结果，不调用模型。它证明题目和检查能区分这些状态，不代表 agent 已经解题。

需要真实模型时，先按 [README](../../README.md#模型与环境变量) 配置环境变量，再执行以下示例。地址和模型需支持所选协议；命令会产生模型调用费用。

```sh
node src/cli/main.ts eval run --provider openai --model gpt-6.1-sol --split all --repeat 2
node src/cli/main.ts analyze <baseline-run> --provider openai --model gpt-6.1-sol
node src/cli/main.ts eval run --provider openai --model gpt-6.1-sol --variant <variant-dir> --split all --repeat 2
node src/cli/main.ts eval compare <baseline-run> <candidate-run>
```

尖括号内容是需要替换的路径：第一次运行输出 baseline 目录，analyze 输出 variant 目录，第三次输出 candidate 目录。以上示例选 OpenAI Responses；Anthropic Messages 端点使用对应 provider/model 和环境变量。

比较时先核对模型、配置、任务和预算，再分别观察 dev/heldout 的通过率、平均 token、轮数和工具错误。结合会话记录解释差异，例如检查反馈是否促成了有效修复，以及增加了多少调用。

不要预设一定会提升：没有失败时就没有来自失败的调整证据；重复运行的差异也可能来自模型波动。这 8 个小任务适合开发回归，不能支撑广泛的编码能力结论。单独的缓存实测也不能替代这组任务的前后对比。

## 回到完整系统

到这里，整个构建过程形成闭环：模型提出行动，工具执行；会话保存过程，上下文控制输入长度；检查推动继续修复，记忆提供跨会话经验；评测再判断这些设计对任务结果有什么影响。

源码阅读顺序：[task.ts](../../src/eval/task.ts) → [runner.ts](../../src/eval/runner.ts) → [judge.ts](../../src/eval/judge.ts) → [analyze.ts](../../src/eval/analyze.ts) → [compare.ts](../../src/eval/compare.ts)。

思考题：候选在开发任务上多通过一题，但保留任务少通过一题、平均 token 翻倍，能否直接称为改进？你还需要哪些重复运行和失败证据，才能决定采用它？

返回[学习路线与系统组装图](README.md)。原始参考资料见[项目 README 文末](../../README.md#参考资料与借鉴)。
