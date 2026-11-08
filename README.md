# mini-harness

一个小而完整的编码 agent harness：TypeScript、Node ≥ 24、零运行时依赖。支持 Anthropic Messages 和 **OpenAI Responses（`/v1/responses`）**；OpenAI 适配器只使用 Responses。

具备流式 agent 循环、read/write/edit/bash 四个工具、JSONL 会话与 trace、轻量权限、两级上下文压缩、hooks 反馈、Ralph 循环、项目记忆与 dream、dev/heldout 评测及 prompt 变体分析。

## 安装与运行

从项目根目录执行；Windows 使用 PowerShell 7，WSL 使用 Ubuntu bash。依赖应在实际开发所用的平台安装。

```sh
pnpm install
pnpm check
node dist/cli/main.js --help
```

开发时用 `pnpm dev`，构建后用 `node dist/cli/main.js`。下文的 `mh` 表示该构建入口；也可以自行执行 `pnpm link --global` 安装命令行链接。

Windows shell 自动选择 Git Bash → pwsh → powershell；不会把 Windows 的 WSL bash launcher 当作 Git Bash。工具描述和 Environment 会告诉模型当前 shell 语法。Windows 用系统自带 PowerShell/.NET Job Object 管理 shell 后代，超时/中断通过 `taskkill` 结束整个 job；POSIX 终止进程组。Windows 工具调用结束后不会保留后台进程。

## 模型与环境变量

OpenAI Responses，Windows PowerShell：

```powershell
$env:OPENAI_API_KEY = '<YOUR_API_KEY>'
$env:OPENAI_BASE_URL = 'https://your-endpoint.example'
node dist/cli/main.js -p '检查项目并修复失败的测试' --provider openai --model gpt-6.1-sol
```

WSL Ubuntu：

```sh
export OPENAI_API_KEY='<YOUR_API_KEY>'
export OPENAI_BASE_URL='https://your-endpoint.example'
node dist/cli/main.js -p '检查项目并修复失败的测试' --provider openai --model gpt-6.1-sol
```

base URL 可以是站点根路径或以 `/v1` 结尾；客户端补齐 `/v1/responses`。请求使用 `store: false`，会话保存在本机；返回的原生 output items 随 JSONL 保存，用于后续回传加密推理和工具调用。

Anthropic 使用 `--provider anthropic --model <model-id>`。鉴权依次取模型的 `apiKeyEnv`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`；最后一种发送 Bearer token。`ANTHROPIC_BASE_URL` 可覆盖默认地址。

密钥只放环境变量。配置中出现 `apiKey`、`token` 等字段会报错，错误信息不回显字段值。模型价格未知时显示 `n/a`；上下文默认 128000、输出默认 8192 是保守回退，实际窗口、价格和 thinking 能力应按所用端点的说明配置。

## 配置与权限

合并顺序：默认 → `~/.mh/config.json` → 项目 `.mh/config.json` → CLI 参数。`MH_HOME` 可覆盖数据目录。未知字段会报错并给出路径。

例如 `.mh/config.json`：

```json
{
  "provider": "openai",
  "model": "gpt-6.1-sol",
  "models": {
    "gpt-6.1-sol": {
      "provider": "openai",
      "apiKeyEnv": "OPENAI_API_KEY",
      "supportsThinking": true
    }
  },
  "thinking": "off",
  "hooks": {
    "afterEdit": [{ "match": "**/*.{ts,js}", "command": "node --check \"$MH_FILE\"", "timeoutSec": 30 }],
    "onStop": [{ "command": "node --test", "timeoutSec": 120 }],
    "maxStopContinuations": 2
  }
}
```

上述 hook 命令使用 bash 语法。PowerShell 回退时使用 `$env:MH_FILE`，例如 `node --check $env:MH_FILE`。文件路径通过环境变量传递，不插入命令文本。

项目 hooks 首次使用需要信任确认；配置改变后重新确认。无人值守默认忽略未信任的项目 hooks 并警告，`--trust-project` 显式信任当前配置。全局 hooks 可信。

默认允许读文件、工作区/会话/项目记忆中的普通写入；工作区外写入与危险命令需确认。无人可问时拒绝；`--yolo` 放行普通操作。Dream/analyze 的写入范围始终受限。

权限层是防误操作的护栏，**不是安全边界**。命令模式检查可以被绕过；无人值守执行不可信内容应使用容器或操作系统隔离。

## 常用命令

```sh
mh                                  # 交互模式
mh -p '修复测试'                      # 只输出最终回复
mh -p '解释项目' --json               # 每行一个 AgentEvent
mh -c                               # 续接最近会话
mh -r <session-id> '继续'             # 续接指定会话
mh sessions
mh trace latest --json
mh ralph '修复测试' --check 'node --test' --max-iter 5
```

可选 `--provider`、`--model`、`--thinking off|low|medium|high`、`--prompts <dir>`、`--max-turns N`、`--cwd <dir>`。打印模式退出码：0 完成、1 错误/轮次预算耗尽、2 参数错误、130 中断。

交互支持 `"""` 分隔的多行输入、运行中排队输入、Ctrl+C 中断、空闲时双按 Ctrl+C 退出。命令包括 `/help /model /compact /clear /cost /session /memory /exit`。工具输出与编辑 diff 追加显示，非 TTY 或 `NO_COLOR` 时无 ANSI 转义。

长输出保存到会话 `offload/`，模型收到头尾和完整文件路径。上下文先清除旧的大工具结果，必要时生成滚动摘要；原始会话始终保留在 JSONL 中。

## 项目记忆

指令从全局 `MH_HOME/AGENTS.md` 和 git root 到 cwd 沿途的 `AGENTS.md` 收集，缺失时回退 `CLAUDE.md`。系统 prompt 在当前会话实例中冻结，续接进程和新会话重新组装。

每个项目的数据位于 `MH_HOME/projects/<slug>/`：`sessions/` 保存消息、用量、工具和 hook trace；`memory/` 保存 `MEMORY.md` 索引及笔记。索引最多注入 200 行或 25KB。

```sh
mh memory path
mh memory show
mh dream --sessions 10 --dry-run
mh dream --sessions 10
mh memory undo
```

Dream 只有 read/write/edit 工具，输入是最近会话，写入只允许记忆目录。前后用独立 Git 仓库留快照；dry-run 在副本中执行；undo 先显示 diffstat 并要求交互确认。Git 不可用时普通记忆仍可用，dream 拒绝执行。

## 评测与改进

8 个纯 Node 种子任务分为 5 个 dev 和 3 个 heldout。每次尝试有独立工作区、home、会话和 prompt 快照，结果保存在 `results.jsonl`、`run.json`、`summary.md`。

```sh
mh eval run --provider openai --model gpt-6.1-sol --split all --repeat 2 --concurrency 2
mh analyze <run> --provider openai --model gpt-6.1-sol
mh eval run --variant <variant-dir> --split all --repeat 2
mh eval compare <baseline-run> <candidate-run>
```

`--tasks 'fix-*'` 按任务 ID 筛选；`--output <dir>` 指定新结果目录。已有 `results.jsonl` 的目录不会被覆盖。评测命令全通过退出 0，存在失败退出 1；结果仍完整落盘。

Analyze 只输入 dev 失败，不输入 heldout。它产出独立变体和 `analysis.md`，不会替换默认 prompts。没有 dev 失败时直接报告无需修改。比较报告分别展示 dev/heldout 的通过率、token、轮数与工具错误。

## 验证与开发地图

```sh
pnpm check
node scripts/test-inventory.ts --verify
node scripts/validate-tasks.ts
```

当前开发验收默认使用 StepFun `step-5-preview`。PowerShell 配置如下（密钥自行填入环境变量）：

```powershell
$env:ANTHROPIC_AUTH_TOKEN = '<YOUR_API_KEY>'
$env:ANTHROPIC_BASE_URL = 'https://api.stepfun.com/step_plan/v1/messages'
$env:MH_LIVE = '1'
$env:MH_LIVE_PROVIDER = 'anthropic'
$env:MH_LIVE_MODEL = 'step-5-preview'
pnpm test:live
```

WSL 使用同名环境变量的 `export` 写法。可通过 `MH_LIVE_PROVIDER=openai`、`MH_LIVE_MODEL=<id>` 和 OpenAI 环境变量切换到 Responses 验收。不设置 `MH_LIVE` 时明确显示 skip。完整改进流程可执行 `node scripts/live-improvement.ts`，它运行两组 8×2 尝试并保存比较结果。

`src/` 按 util → ai → agent/session → tools/context/memory/hooks → app → eval → cli 分层；脚本检查依赖方向与内核 IO 约束。测试运行在临时 `MH_HOME`，默认禁止远程网络；已通过的测试名由 inventory 防止消失或被跳过。

测试基线保存在 `test/test-baseline.json`，可通过 `node scripts/test-inventory.ts --verify` 验证。v1 不包含 MCP、全屏 TUI、原生子 agent 工具、后台任务服务或会话分支。
