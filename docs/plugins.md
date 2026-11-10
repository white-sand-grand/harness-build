# 组合工具、上下文、记忆与提示词

例如，解释一个陌生项目时，可以启用“查找文件 + 动态目录概览”，保留原来的 read 工具；修改代码时再启用 write、edit、bash。两种组合保存为 profile，在同一个交互会话的两次任务之间切换。

mini-harness 的 runtime 把这些组合固定成版本快照，为可比较的自进化实验和明确的版本采用提供边界。新任务可以使用经过选择的新版本，已经开始的任务继续原来的组合。默认配置使用四个内置工具与文件记忆。

插件使用自有的 `mh-plugin.json` 与 Node worker 契约，不声明 MCP 或 Agent Plugins 格式兼容。设计原理见课程的[能力组合](learn/08-composition.md)、[版本与热加载](learn/09-runtime.md)和[进化与采用](learn/11-prompt-evolution.md)；本文提供配置与接口查阅。完整接口见 [plugin-types.ts](../src/app/plugin-types.ts)，可运行示例见 [project-context](../examples/plugins/project-context/main.mjs)。

## 从项目目录示例开始

先按 [README](../README.md#安装与运行) 安装依赖和配置模型。从 mini-harness 仓库根目录运行时，将以下内容合并到项目 `.mh/config.json`；已有配置保留，只添加 `runtime` 字段：

```json
{
  "runtime": {
    "profile": "project",
    "plugins": ["examples/plugins/project-context"],
    "watch": false,
    "profiles": {
      "project": {
        "tools": ["read", "project__find_file"],
        "context": ["project/overview"],
        "memory": [],
        "prompts": ["project/navigation"],
        "hooks": ["project/find-hint"],
        "reducer": "clear",
        "offload": true
      },
      "coding": {
        "tools": ["read", "write", "edit", "bash", "project__find_file"],
        "context": ["project/overview"],
        "memory": ["file-index", "project/recent"],
        "prompts": ["project/navigation"],
        "hooks": ["project/find-hint"],
        "reducer": "default",
        "offload": true
      }
    }
  }
}
```

`project` 组合用于查找和阅读；`coding` 加上写入、执行以及可选的跨任务记忆。示例的 `project/recent` 在运行成功后保存最近五次任务的前 200 个字符，文件位于 `MH_HOME/examples/project-context/`，按显式工作目录的 hash 区分。将它从 `memory` 列表移除即可停用；删除对应 JSON 文件可以清空示例记忆。

Windows PowerShell 7，仓库根目录：

```powershell
$env:ANTHROPIC_API_KEY = '<YOUR_API_KEY>'
node src/cli/main.ts --provider anthropic --model '<YOUR_MODEL_ID>' --profile project --watch
```

WSL Ubuntu bash，仓库根目录：

```bash
export ANTHROPIC_API_KEY='<YOUR_API_KEY>'
node src/cli/main.ts --provider anthropic --model '<YOUR_MODEL_ID>' --profile project --watch
```

模型 ID 与凭据使用所选平台实际提供的值。兼容端点可另外设置 `ANTHROPIC_BASE_URL`；OpenAI Responses 的设置沿用 README。密钥保存在环境变量中，插件清单和项目配置只放非秘密数据。

启动时确认已审查的插件内容，然后输入“查找配置读取入口并解释相关文件”。交互空闲时可输入：

```text
/plugins
/profile coding
/profile
/reload
```

`/plugins` 显示当前 profile、插件版本与 fingerprint、活动运行数及加载错误。`/profile` 无参数时显示当前名称，带名称时装配并切换组合。`/reload` 重读配置、声明的插件文件、基础提示词和项目说明；失败时保留上一份可用快照。模型仍通过 `/model` 或 `--provider`、`--model` 选择，profile 不包含模型路由。

只检查插件能否加载、不请求模型时，两种 shell 都可以执行：

```sh
node src/cli/main.ts plugins --profile project --trust-project --json
```

这里的 `--trust-project` 明确批准本次启动看到的项目 hooks 和精确插件 fingerprint。使用前先阅读示例模块。

## profile 可以组合什么

各类插件贡献按给出的顺序选择，省略字段使用默认值；`[]` 表示不选该类能力。不存在或重复的 ID 会导致装配失败。

| 字段             | 内容与默认值                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `tools`          | 模型可调用的工具；默认 `read/write/edit/bash`。外部工具名称为 `插件ID__工具名` |
| `context`        | 每次模型请求前调用的动态上下文提供者；默认空列表                               |
| `memory`         | 默认 `file-index`，也可选择 `file-recall` 和插件记忆策略                       |
| `prompts`        | 追加到基础 system prompt 的插件片段；默认空列表                                |
| `hooks`          | 插件的 `beforeTool`、`afterTool`、`onStop`；默认空列表                         |
| `reducer`        | `default`、`clear`、`none` 三选一，默认 `default`                              |
| `offload`        | 是否启用装配层的长工具输出截断与落盘，默认 `true`                              |
| `promptsDir`     | 基础提示词目录，结构与仓库 `prompts/` 相同                                     |
| `promptArtifact` | 已发布的提示词 artifact 清单，与同一 profile 的 `promptsDir` 二选一            |

`default` 沿用原有清理旧输出与模型摘要策略，阈值仍由 `compaction` 配置控制。`clear` 只清理旧工具结果，不调用模型生成摘要；`none` 关闭自动 reducer。`offload` 独立选择，关闭它不会取消工具自身的读取长度、进程输出或超时限制。

内置 `file-index` 将文件记忆索引放入稳定的系统提示。`file-recall` 在每次模型调用前重新读取索引，两者互斥。动态内容依次来自内置文件召回、选中的插件 `recall()` 和 `context.provide()`；结果作为本次请求的临时 system 后缀，不追加成持久消息。原始会话仍保存实际用户消息和工具结果。

`remember()` 是可选回调：仅在模型循环完成后调用，并使用该次运行持有的原版本策略。中断、错误和轮数耗尽不会被当作成功记忆。写回失败会记录 hook 错误，并以错误结束本次运行；不会先记录成功再抛出失败。系统提示、基础提示词和插件片段在一次运行内固定；动态 context 与 recall 可以每轮重新读取显式路径下的数据。

插件 hook 不替代内置权限检查。`beforeTool` 可以进一步拒绝操作，`afterTool` 可以补充反馈，`onStop` 可以返回继续消息；所选 hook 顺序与 profile 一致。reducer 使用上述内置单选项，worker 插件不能直接替换压缩内部实现。

## 热加载的生效时间

`--watch` 开启输入变化检测，在下一次完整 `startRun()` 获取快照前尝试 reload。它不会在每次模型调用间替换代码。手动 `/reload` 与 `/profile` 也用于两次运行之间，交互界面忙碌时会提示等待当前运行结束。

例如任务 A 已调用 v1 的工具，此时磁盘更新为 v2：

1. A 持有 v1 的 lease，后续模型请求、工具以及最终 `remember()` 仍使用 v1。
2. 运行中排队的 steering 输入属于 A，也继续使用 v1。
3. A 结束后，下次用户任务 B 可以在同一个 session 中取得 v2。
4. 旧 worker 在最后一份 lease 释放后关闭。v2 初始化或配置校验失败时，B 继续取得上一份可用版本。

程序调用可以通过 `createRuntime()` 持有管理器，把它传给 `startRun({ runtime, ... })`，并在退出时 `await runtime.close()`。`runtime.reload()` 可以准备新版本，同时让已经取得 lease 的调用完成；关闭管理器前应先取消并等待自己的运行任务。

## 编写一个插件

示例清单位于 [mh-plugin.json](../examples/plugins/project-context/mh-plugin.json)：

```json
{
  "id": "project",
  "version": "1.0.0",
  "module": "main.mjs",
  "files": ["main.mjs"]
}
```

模块 default export 的 `id`、`version` 必须与清单一致。`files` 显式列出需要进入快照的模块和本地资源，宿主自动包含清单自身；相对导入的本地文件也要声明。`.mjs`、`.js`、Node 24 可直接运行的 `.ts` 都可作为入口。路径不能逃出插件目录，也不能使用符号链接或特殊文件。

本地 ID 由字母开头，最多 32 个字符，后续可使用字母、数字、下划线和连字符。宿主为贡献加上命名空间：示例的工具是 `project__find_file`，其余条目是 `project/overview`、`project/recent`、`project/navigation` 和 `project/find-hint`。

[示例 main.mjs](../examples/plugins/project-context/main.mjs) 展示完整贡献：

- 查找工具只匹配相对路径，跳过隐藏条目、生成目录与符号链接，并限制遍历深度、条目数和返回量。
- 动态上下文列出当前项目顶层条目，`recall/remember` 使用单独的本地 JSON 记忆。
- prompt 片段指导模型先定位再阅读，hook 在查找结果后补充下一步提示。

工具使用 `execute(args, ctx)`，上下文和记忆使用对应回调。通过 `ctx.cwd`、`ctx.home`、`ctx.sessionDir` 显式定位文件，并响应 `ctx.signal`；不要依赖 worker 的进程当前目录或调用 `process.chdir()`。工具可通过 `ctx.onUpdate` 返回进度，最终返回 `{ content: [...] }`。插件 hook 的参数以 [类型契约](../src/app/plugin-types.ts) 为准。

## 信任、权限与 worker 边界

加载前先读取清单和声明文件，计算内容 fingerprint；获批后才执行模块。修改声明文件的代码或资源即产生新 fingerprint，即使 `version` 没变也要重新确认。只改版本号同样改变清单内容。`--trust-project` 批准启动时的精确内容，不会自动批准同一进程里后续的源码变化。watch 发现新代码时，无人可问或审批被拒绝会保留旧版本。

插件放在独立 worker 中，拥有独立的模块缓存和模块级状态，宿主只传递可序列化数据与取消信号。worker 不继承模型 API 密钥环境变量。但 **worker 不是操作系统沙箱**：获批的插件仍能导入 Node 文件和网络 API。信任应覆盖插件的模块初始化及回调代码。

worker 契约不支持插件自行创建子进程，宿主会拒绝常规 `child_process` / `cluster` 模块入口，命令执行交给内置 bash 工具管理。原因是强制终止 worker 无法回收它启动的操作系统进程树；这项契约检查也不构成恶意代码沙箱。

外部工具的 `readOnly` 自报属性不会绕过执行审批。默认模式下，调用外部工具仍需确认；选择会话允许只作用于该工具与精确 fingerprint。无人值守运行、eval 和 evolve 如需执行已审查的外部工具，可显式使用 `--yolo`；加载信任与工具动作授权是两项独立检查。

## 运行、评测与优化的边界

普通交互、打印运行、`eval run` 和 `evolve` 支持 runtime。dream、analyze 等维护操作，以及带写入范围限制的 Ralph，继续使用受限的内置能力。手动 `/compact` 使用当前组合选定的内置 reducer，不执行外部工具、临时检索或记忆写回。程序调用设置 `systemOverride`、`toolsFilter`、读写范围或禁用项目指令时，也不会把外部插件带入维护运行。

评测会冻结 profile、提示词及已批准的插件源码，每个 attempt 在自己的工作区和 home 中从冻结代码另建 worker，避免模块级状态在任务之间串用。watch 不改变正在评测的条件。插件若通过自身代码访问其他外部服务或共享文件，这些外部状态仍需要调用方控制。

以下命令适用于仓库根目录的 PowerShell 7 和 WSL Ubuntu bash；模型与密钥使用前面配置的环境：

```sh
node src/cli/main.ts eval run --profile coding --trust-project --yolo --split dev --repeat 2
node src/cli/main.ts evolve --profile coding --trust-project --yolo --rounds 1 --candidates 1 --max-calls 120 --timeout 600 --output evals/runs/my-profile-evolution
```

输出目录使用新名称，避免覆盖已有评测。通过率、终止原因、无效执行和评分错误分别判断；一次普通运行结束不等于评测通过。

优化器使用独立的程序接口：

```ts
import { analyzeRun } from '../src/eval/analyze.ts';
import type { PromptOptimizer } from '../src/eval/optimizer.ts';

const optimizer: PromptOptimizer = {
  id: 'project-evidence',
  version: '1',
  propose: analyzeRun,
};
// 在应用已有的 EvolutionOptions 上传入：runEvolution({ ...options, optimizer })。
```

`PromptOptimizer` 只替换候选生成步骤。文件修改范围、候选校验、dev gate、新一轮配对确认和 heldout 审计仍由宿主执行，评分器与 gate 不由插件替换。CLI 当前使用内置 `evidence` 优化器；`--optimizer-model` 与 `--optimizer-provider` 选择它使用的模型。worker `PluginDefinition` 和 profile 没有优化器注册字段。

仅最终 `recommend` 或 `unchanged` 会生成输出目录中的 `prompt-artifact.json`。`recommend` 选择经过确认和最终审计的候选；`unchanged` 选择基线，不能把它解释为优化收益。清单记录优化器 ID/版本、整体 hash、逐文件 SHA256、父版本 hash，以及输出目录内的相对提示词路径。

要采用这一版本，在目标 profile 中显式指定清单：

```json
{
  "promptArtifact": "evals/runs/my-profile-evolution/prompt-artifact.json"
}
```

保留该 profile 的其他选择，并移除它的 `promptsDir`。加载时会验证成功决策、文件列表、逐文件 hash、整体 hash 与目录范围；文件被改动时拒绝加载并保留原快照。artifact 选择基础提示词 bundle，profile 选中的插件 prompt 片段仍按配置拼接。生成候选和 artifact 都不会自动覆盖仓库默认提示词。

运行记录中的 `runtime` trace 包含所用版本及快照文件路径，可以核对实际启用的组合。真实验收分别见 [plugins.test.ts](../test/live/plugins.test.ts) 和 [runtime-evolution.test.ts](../test/live/runtime-evolution.test.ts)，门控为 `MH_LIVE_PLUGINS=1` 与 `MH_LIVE_RUNTIME_EVOLUTION=1`；测试只有显式启用才调用远程 API。Step 的实际结果、受控缺陷实验范围与调用统计见[验收报告](reports/pluggable-runtime-validation.md)。
