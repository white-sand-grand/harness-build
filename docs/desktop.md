# 桌面工作台

mini-harness Desktop 是原生 Windows x64 编程工作台，复用与 CLI 相同的 Agent 内核。打开项目后，可以创建/续接会话，选择模型与思考深度，查看真实工具过程，批准或拒绝需要确认的操作，停止任务，并审阅当前 Git 工作区差异。

界面采用暖白纸面、满月标识和浅深主题。思考时月相从残月逐渐盈满；它表示正在处理，不代表完成百分比。等待确认或停止后动效结束，系统启用“减少动态效果”时使用静态月相。

## 使用安装包

Windows 安装包构建在 `desktop/release/`，免安装程序位于 `desktop/release/win-unpacked/mini-harness.exe`。桌面程序自带 Electron 和 Node，不要求为 Agent 内核另外安装系统 Node。项目实际使用的 Git、Node、Python 等开发工具仍需按项目需要准备。

当前安装包未签名。首版只支持 Windows 本机执行；它不是 WSL、远程主机或容器执行器。

1. 启动 mini-harness，选择一个本地项目文件夹。
2. 打开“模型连接”，填写协议、**模型 ID**和**服务地址（Base URL）**。模型 ID 是模型名称，不能填网址。支持 Anthropic Messages 和 OpenAI Responses 兼容接口。
3. 默认选择“直接输入密钥（推荐）”，把实际 API Key 粘贴到密码框。需要使用已有环境变量时，再切换到“环境变量引用（高级）”，这里只填 `STEP_API_KEY` 这样的变量名，不能填密钥本身。连接元数据保存在数据目录，直接输入的密钥只留在当前应用进程内存；重启后需重新提供，或从启动环境读取。
4. 选择模型与思考深度，描述任务并发送。运行中补充要求会进入当前运行，改选模型/深度用于下一次完整运行。
5. 查看工具输出、检查结果与变更。执行结束和检查通过是不同状态，没有配置检查时显示“未配置结束检查”。

“默认”思考深度不额外指定预算/effort，不保证模型完全不推理。“可调思考”等能力由连接配置声明，不能据此视为远端已验证；只有对应接口支持时才启用。

例如连接阶跃星辰时，协议选 **Anthropic Messages**，模型 ID 填 `step-5-preview`，服务地址填 `https://api.stepfun.com/step_plan`（也支持完整的 `/v1/messages` 地址），实际密钥填在 **API Key 密码框**。这三个值对应不同字段，不要互换。

表单会同时指出误填字段并定位首个错误。还未发送保存请求的校验失败会保留密码；真正发送后立即清空密码框。旧连接如果误把网址存成模型 ID，会在列表标为“需要修正”并阻止运行，仍可打开设置更正；切换到直接密钥模式后，保存时不会携带旧环境变量名。

## 项目、会话与权限

默认数据目录为 `~/.mh/`，`MH_HOME` 可覆盖；会话继续使用现有 JSONL。桌面 UI 缓存位于数据目录的 `desktop-app/`。打开历史不会自动重跑文件修改或命令；旧历史缺少完整工具详情时会显示限制。

同一应用中只允许一个活跃运行。任务执行期间切换项目或会话会被拒绝；关闭应用会先提示停止，并等待命令清理。审批支持本次、当前会话和拒绝，授权与实际动作/运行关联；模型切换不会自动放行权限。

项目配置中的检查命令首次使用需要确认。“本次”和“会话”不写入永久信任；检查配置改变后需要重新确认。现有危险命令识别与路径检查属于轻量权限层，不是 OS 安全沙箱。

Git 面板展示**工作区当前全部变更**，包含已暂存、未暂存和用户原有修改；未跟踪文件先列出名称。它不声明所有变动均由本次任务产生，也不提供自动撤销、提交或推送。

## 从源码运行

以下命令从仓库根目录在 **Windows PowerShell 7** 执行。桌面依赖安装在 `desktop/`，不要共享根目录的 WSL `node_modules`。

```powershell
cd .\desktop
pnpm install
pnpm exec install-electron
pnpm dev
```

开发需要 Node 24+、pnpm 和 Git。`pnpm dev` 先构建再启动，当前不提供热更新。也可以先 `pnpm build`，再 `pnpm start -- --project 'D:\path\to\project'` 打开指定项目。

```powershell
pnpm check              # 类型、Host行为测试、生产构建
pnpm smoke              # 临时home启动真实Electron并验证资源/桥接
pnpm test:job           # Windows Host进程监护回收
pnpm test:gui           # 本地HTTP替身驱动真实GUI和内核
pnpm dist               # 构建Windows安装包
```

GUI/Host测试使用临时数据目录和本地模型替身，不需要真实密钥，不以固定文本替代工具执行。根目录的 WSL `pnpm check`、测试清单与任务检查仍是核心门禁；桌面原生检查单独执行。

打包脚本复用已安装的Electron分发，将工具缓存与临时提取放在`desktop/.cache/`，不修改系统环境设置。首版安装包按当前用户构建，不包含提权辅助程序或自动更新。第三方许可位于应用目录的`dist/licenses/`及Electron自带声明。

## 工程边界

React renderer只消费受约束的数据；sandbox preload不暴露Node或通用IPC。Electron main管理窗口、原生文件选择与Host生命周期，独立Host调用现有`startRun`。模型密钥以实例私有字段注入，工具环境不继承模型密钥。

Windows Host在接收任务前加入Job Object，主进程失联或Host退出时清理其后代；正常取消仍沿用核心工具的进程清理路径。构建分别输出ESM main/host、CJS preload和浏览器renderer，并明确复制prompts、插件worker及PowerShell资源。

首版聚焦可完成的编程任务闭环；评测、提示词进化和版本采用仍可使用现有CLI。桌面中执行实验、WSL、worktree并行和自动更新属于后续范围。

[MVP验证报告](reports/desktop-mvp-validation.md)列出了核心回归、真实Electron GUI、本地模型替身和Windows进程清理的验证范围与限制。

[0.1.1真实Step验证](reports/desktop-step-validation.md)记录了连接表单误填修复、Step专用思考参数映射，以及真实低/中档任务、一次性审批和恢复结果。更新时先退出旧版；API Key填密码框，环境变量高级模式只填变量名称。
