# 08 · 把改进对象拆成可组合的能力

[学习路线](README.md) · 上一章：[项目记忆](07-memory.md) · 下一章：[版本快照与热加载](09-runtime.md)

假设我们要判断“更明确的工具说明能否减少错误调用”。如果实验同时换了工具实现、记忆内容和压缩方式，任务通过也无法说明是哪项变化起作用。自进化需要先把变化对象拆清楚，再固定本次实验中不允许变化的部分。

本章把工具、上下文、记忆、提示词和反馈组成明确的 profile。提示词优化在这个固定组合上进行；能力实现仍由开发者编写和选择。

## 从两套任务组合开始

“解释陌生项目”和“修复测试”可以共用内核，但需要不同能力：

| 选择       | 项目分析           | 编码修复                           |
| ---------- | ------------------ | ---------------------------------- |
| 工具       | read、文件定位插件 | read/write/edit/bash、文件定位插件 |
| 临时上下文 | 当前项目结构       | 当前项目结构                       |
| 记忆       | 不启用             | 文件索引与已完成任务记录           |
| 历史缩减   | 清理旧输出         | 清理与摘要                         |
| 提示词片段 | 先定位再阅读       | 先定位再阅读                       |

profile 保存的是这些选择及其顺序，不承载新的 agent 循环。模型接收的工具定义与实际执行函数仍遵守第二章的 `Tool` 契约。

## 接口、贡献、组合分别是什么

以仓库中的 [project-context 插件](../../examples/plugins/project-context/main.mjs)为例：

| 层次 | 例子                                    | 职责                           |
| ---- | --------------------------------------- | ------------------------------ |
| 接口 | `execute(args, ctx)`                    | 约定工具如何接收输入、返回结果 |
| 贡献 | `project__find_file`                    | 提供一个具体文件定位工具       |
| 组合 | `tools: ["read", "project__find_file"]` | 决定一次运行暴露哪些工具       |

[PluginDefinition](../../src/app/plugin-types.ts) 允许一个模块贡献多类能力。完整导出示例见上面的真实模块；下面是说明字段关系的片段：

```ts
{
  id: 'project',
  version: '1.0.0',
  tools: [/* 带 execute 的工具 */],
  context: [/* { id, provide(ctx) } */],
  memory: [/* { id, recall(ctx), remember?(ctx, reason) } */],
  prompts: { navigation: '先定位，再读取实际文件。' },
  hooks: [/* { id, beforeTool?, afterTool?, onStop? } */],
}
```

宿主将工具名变成 `插件ID__工具名`，其他贡献变成 `插件ID/本地ID`。这样两个插件的同名局部能力有各自的身份。重复 ID、未知选择及伪装成内置工具的名称会被拒绝。

## 用 profile 描述完整组合

下面的 JSON 只展示 runtime 配置，应合并进项目配置。完整安装、信任和命令用法见[使用指南](../plugins.md)。

```json
{
  "runtime": {
    "profile": "analysis",
    "plugins": ["examples/plugins/project-context"],
    "profiles": {
      "analysis": {
        "tools": ["read", "project__find_file"],
        "context": ["project/overview"],
        "memory": [],
        "prompts": ["project/navigation"],
        "hooks": ["project/find-hint"],
        "reducer": "clear",
        "offload": true
      }
    }
  }
}
```

[RuntimeManager](../../src/app/runtime.ts) 校验选择，再由 [buildAgent](../../src/app/build-agent.ts) 组装 `AgentConfig`。默认字段保持明确：工具是原有四工具，记忆是 `file-index`，其他插件贡献默认不选；`[]` 表示明确关闭该类能力。模型仍由模型配置、CLI 或 `/model` 选择。

## 检索输入与历史改写要分开

例如，记忆插件召回“该项目用 ESM”，上下文插件补充“配置入口位于 src/app”。这些文字可以帮助本轮模型，但不必成为永久历史消息。

`modelContext` 在每次模型请求前依次获取文件召回、插件 `recall()`、`context.provide()` 的文字，追加为本次请求的临时 system 后缀。持久消息数组不因此增加条目。模型回复和工具参数仍可能引用这些文字；“临时”描述的是输入装配方式，不承诺内容永远不会出现在记录中。

压缩则会替换真实历史，需要第四章的可重建记录。`beforeModel` 的 `ContextReplacement` 只支持明确的 compaction/clearing 语义，因此 reducer 单选：

- `default`：按阈值清理或生成摘要。
- `clear`：只清理旧工具结果，不生成模型摘要。
- `none`：不执行自动历史缩减。

检索提供者可以有多个，持久历史改写器保持一个，避免最终模型输入与重建日志发生分歧。长输出 offload 独立选择；关闭它也不会取消文件工具和进程本身的输出限制。

## 记忆不是提示词候选

`file-index` 把索引放入稳定提示词快照；`file-recall` 每轮重新读取索引，两者互斥。插件的 `recall()` 和成功后的 `remember()` 则可以实现自己的记录方式。

记忆是在保留项目经验；提示词进化是在验证一般行为指令。不能仅因为某次任务成功，就把整个回复写进 system.md。`remember()` 失败时运行记录也必须是错误终态，防止“模型已结束”被误当成“所有后处理成功”。

## 哪些部分可以替换，哪些保持固定

普通插件可以补充 `beforeTool/afterTool/onStop`；内置权限检查与基础 trace 保留。外部工具自报 `readOnly` 不能绕过授权，更新后的指纹也不能继承旧工具的会话批准。插件结束检查的自动继续受宿主预算限制。

当前 `evolve` 自动搜索 `system.md` 与组合中实际启用的内置工具说明。工具实现、上下文算法、记忆算法、评分器和模型权重保持固定。开发者可以更换组合并另做实验，但这不等于优化器已经能自动改写这些实现。

## 运行与验证

项目根目录，PowerShell 7 或 WSL Ubuntu bash：

```sh
node docs/learn/examples/runtime.ts
node --import ./test/helpers/setup.ts --test test/unit/app/runtime.test.ts test/unit/agent/model-context.test.ts test/unit/hooks/external-permission.test.ts
```

[离线示例](examples/runtime.ts)只固定模型回复。worker、真实文件读取、临时上下文、记忆写回、hook 和 profile 选择均使用项目实现，所有文件都位于临时目录，结束后清理，不读取个人模型配置。

源码阅读顺序：[plugin-types.ts](../../src/app/plugin-types.ts) → [runtime.ts](../../src/app/runtime.ts) → [build-agent.ts](../../src/app/build-agent.ts) → [compose.ts](../../src/hooks/compose.ts)。

思考题：只启用 read 的 profile，是否应该允许优化 edit 的说明？如果两种压缩器都替换了历史，日志应该记录哪一份变化？

下一章：[让经过选择的版本在明确的边界生效](09-runtime.md)。
