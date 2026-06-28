# Token炼金师 (AtomCode Mini)

> 零依赖、纯 Node.js 内置模块手搓的 AI Coding Agent。

不依赖任何第三方库（无 openai SDK、无 langchain、无 commander），仅用 Node 18+ 原生 `fetch` / `readline` / `child_process` / `fs` 实现一个能读写文件、搜索代码、运行命令、管理任务、跨会话记忆、技能复用的命令行编程助手。可用 Bun 一键编译成单文件 `agent.exe`。

## 特性

- **零依赖** — `npm install` 都不用，开箱即跑
- **流式输出** — 思考文本与命令输出实时打印，不等整段返回
- **Function Calling** — 通过 OpenAI 兼容协议调用工具，ReAct 循环驱动（最多 25 轮）
- **11 个内置工具** — 读写编辑文件、并发多文件编辑、流式命令、grep、todo、skills、memory
- **技能系统 (Skills)** — 可复用工作流模板，YAML frontmatter + 结构化正文，支持参数校验
- **三层记忆** — 项目级长期记忆（`.agent/memory.md`）、多会话持久化、上下文自动压缩
- **多会话管理** — 新建/切换/重命名/删除会话，各自独立历史与摘要
- **上下文自动压缩** — 历史超阈值自动摘要，保留最近 12 条原文，二级压缩防摘要过长
- **思考动画** — LLM 等待时显示 spinner + 已用秒数，首个 token 到达即停
- **斜杠命令下拉菜单** — 输入 `/` 弹出匹配命令，↑↓ 选择、Enter/Tab 确认、Esc 关闭
- **兼容任意 OpenAI 协议服务** — OpenAI / DeepSeek / 智谱 / LongCat / 本地 Ollama / vLLM 等
- **可编译为单文件 exe** — `bun build --compile` 打包成 ~94MB 独立可执行文件

## 快速开始

### 环境要求

- Node.js ≥ 18（用了原生 `fetch` 和 ESM）
- 可选：Bun ≥ 1.0（用于编译成 exe）

### 安装

```bash
git clone <your-repo-url> atomcode-mini
cd atomcode-mini
# 无需 npm install
```

### 配置

通过环境变量指定模型服务（任选一种变量名前缀，`LM_` 优先）：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `LM_API_KEY` / `LLM_API_KEY` | API Key（必填） | — |
| `LM_BASE_URL` / `LLM_BASE_URL` | OpenAI 兼容接口地址 | `https://api.longcat.chat/openai` |
| `LM_MODEL` / `LLM_MODEL` | 模型名 | `LongCat-2.0-Preview` |
| `LM_MAX_CHARS` | 上下文压缩阈值（字符数） | `24000` |
| `LM_KEEP_RECENT` | 压缩时保留最近消息数 | `12` |
| `LM_SUMMARY_TRIGGER` | 摘要本身再压缩的阈值 | `16000` |

**示例：用 DeepSeek**

```bash
# Linux / macOS
export LM_API_KEY=sk-xxx
export LM_BASE_URL=https://api.deepseek.com/v1
export LM_MODEL=deepseek-chat
node index.js
```

```cmd
:: Windows cmd
set LM_API_KEY=sk-xxx
set LM_BASE_URL=https://api.deepseek.com/v1
set LM_MODEL=deepseek-chat
node index.js
```

**示例：用本地 Ollama**

```bash
export LM_API_KEY=ollama
export LM_BASE_URL=http://localhost:11434/v1
export LM_MODEL=qwen2.5-coder:7b
node index.js
```

### 编译成单文件 exe（可选）

```bash
bun build --compile --outfile agent.exe index.js
# 产出 agent.exe (~94MB)，可脱离 Node 运行
```

## 使用

启动后进入交互式 REPL：

```
  ╔═════════════════════════════════════════════════════════╗
  ║       ████████╗ ██████╗ ████████╗████████╗███████╗██████╗  ║
  ║       ╚══██╔══╝██╔═══██╗╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗ ║
  ║          ██║   ██║   ██║   ██║      ██║   █████╗  ██████╔╝ ║
  ║          ██║   ╚██████╔╝   ██║      ██║   ███████╗██║      ║
  ║          ╚═╝    ╚═════╝    ╚═╝      ╚═╝   ╚══════╝╚═╝      ║
  ║              ⚗  T o k e n 炼 金 师  ⚗                    ║
  ╚═════════════════════════════════════════════════════════╝

  模型: LongCat-2.0-Preview
  工作目录: D:\myproject
  Skills: commit, debug, new-feature, refactor, review, init-project
  记忆: 3 条
  当前会话: mqrrcu60vpfm (默认会话)
  命令: 输入问题开始 | /sessions | /new | /switch <id> | /rename <名> | /delete <id> | /skills | /memory | /clear | /exit

> 看一下当前目录有什么项目
> 用 Python 写一个快速排序存到 sort.py 并跑测试
> 把 tools.js 里的 grep 改成默认大小写不敏感
```

### REPL 斜杠命令

输入 `/` 会弹出下拉菜单，↑↓ 选择、Enter/Tab 确认、Esc 关闭：

| 命令 | 作用 |
|---|---|
| `/sessions` | 列出所有会话 |
| `/new` | 新建会话 |
| `/switch <id>` | 切换到指定会话 |
| `/rename <名>` | 重命名当前会话 |
| `/delete <id>` | 删除指定会话 |
| `/skills` | 列出可用技能 |
| `/memory [关键词]` | 查看长期记忆（可过滤） |
| `/clear` | 清空当前会话历史 |
| `/exit` | 退出 |

## 工具一览

Agent 通过以下 11 个工具完成任务：

| 工具 | 说明 |
|---|---|
| `read_file` | 读取文件全文（大文件可分段） |
| `write_file` | 创建/覆盖文件，自动建目录 |
| `edit_file` | 精确替换（要求 `old` 在文件内唯一） |
| `edit_files` | **并发**多文件多处编辑，同文件内顺序串行，每处独立报告 |
| `list_dir` | 列目录树（目录后缀 `/`） |
| `grep` | 正则搜索文件内容，跳过 `node_modules` / `.git` |
| `run_command` | 执行 shell 命令，**流式**实时输出，60s 超时，32KB 上限 |
| `todo` | 管理持久化任务清单（`list` / `add` / `update` / `clear`） |
| `list_skills` | 列出所有技能（含版本/标签/必填参数） |
| `use_skill` | 调用技能，校验必填参数，替换 `{{arguments}}`/`{{cwd}}` 占位符 |
| `memory` | 管理项目级长期记忆（`list` / `add` / `delete`） |

## 技能系统 (Skills)

可复用工作流模板，放在 `.agent/skills/*.md`（项目级）或 `~/.atomcode/skills/*.md`（全局级），项目级覆盖全局同名。

### 文件格式（标准规范）

```markdown
---
name: my-skill
version: 1.0.0
author: Token炼金师
description: 一句话说明
tags: [git, 提交]
args:
  - name: message
    description: 自定义提交信息
    required: false
---

## 指令
总体描述

## 步骤
1. 第一步...
2. 第二步...

## 验证
如何确认执行成功

## 示例
- use_skill("my-skill", "参数")
```

### 内置技能

| 技能 | 说明 | 必填参数 |
|---|---|---|
| `commit` | git 提交当前改动，自动生成中文 commit message | — |
| `new-feature` | 开发新功能标准流程（拆 todo→实现→验证） | `feature` |
| `debug` | 调试 bug（复现→定位→修复→验证） | `issue` |
| `refactor` | 重构代码（先补测试→重构→验证行为不变） | `target` |
| `review` | 代码审查（正确性/安全性/可靠性/风格分级） | — |
| `init-project` | 初始化新项目（建目录+配置+git+README） | `tech` |

## 工作原理

```
用户输入
   │
   ▼
┌───────────────┐   无工具调用   ┌──────────┐
│  调用 LLM     │ ───────────► │ 输出回答  │ → 保存会话 → 结束
│ (流式+tools)  │              └──────────┘
└───────┬───────┘
        │ 有 tool_calls
        ▼
┌───────────────┐   并发执行（Promise.all）
│ 执行工具      │ ─────┬────────┬────────┐
└───────────────┘      ▼        ▼        ▼
                  read_file  edit_files  run_command ...
                       │        │        │
                       └───┬────┴────────┘
                           ▼
                  结果作为 tool 消息塞回 history
                           │
                           ├───► 上下文超阈值？→ 自动压缩摘要
                           │
                           └───► 回到「调用 LLM」（最多 25 轮）
```

核心是 **ReAct 循环**：模型思考 → 调用工具 → 观察结果 → 再思考，直到给出最终回答。设了 `MAX_STEPS=25` 防止死循环。

## 三层记忆

| 层级 | 实现 | 作用域 |
|---|---|---|
| 项目级长期记忆 | `.agent/memory.md` + `memory` 工具 | 所有会话共享，每轮注入系统提示 |
| 多会话持久化 | `.agent/sessions/<id>.json` + `index.json` | 每会话独立历史与摘要 |
| 上下文自动压缩 | `compress.js`，超 `LM_MAX_CHARS` 触发 | 单会话内，保留最近 12 条原文，其余摘要 |

## 项目结构

```
agent/
├── index.js       # REPL 入口，logo，斜杠命令下拉菜单，会话切换
├── agent.js       # ReAct 循环，并发执行工具，spinner 集成
├── llm.js         # OpenAI 兼容协议调用，流式 SSE 解析，动态系统提示
├── tools.js       # 11 个工具实现 + JSON Schema + 技能加载
├── compress.js    # 上下文自动压缩，二级摘要
├── sessions.js    # 多会话管理（CRUD + 切换/重命名/删除）
├── memory.js      # 项目级长期记忆
├── spinner.js     # 思考等待旋转动画
├── package.json   # 零依赖声明
├── agent.exe      # bun 编译产物（可选）
└── .agent/        # 运行时自动生成
    ├── sessions/      # <id>.json 每会话 + index.json 索引
    ├── skills/        # *.md 技能文件
    ├── todo.json      # 任务清单
    └── memory.md      # 长期记忆
```

| 文件 | 行数 | 职责 |
|---|---|---|
| `tools.js` | ~597 | 11 个工具实现 + Schema + 技能 frontmatter 解析与加载 |
| `index.js` | ~351 | REPL、logo、斜杠命令下拉菜单（↑↓选择）、会话切换 |
| `sessions.js` | ~184 | 多会话 CRUD，`.agent/sessions/` 持久化 |
| `llm.js` | ~155 | OpenAI 兼容协议调用、流式 SSE 解析、tool_calls 分片累积、动态系统提示 |
| `compress.js` | ~116 | 上下文超阈值自动摘要，保留最近 12 条，二级压缩 |
| `agent.js` | ~99 | ReAct 循环、并发工具执行、spinner 集成、会话保存 |
| `memory.js` | ~76 | 项目级长期记忆读写，注入系统提示 |
| `spinner.js` | ~40 | 思考动画 `⠋⠙⠹...` + 已用秒数，首个 token 停 |

## 持久化数据

运行时会在工作目录下生成 `.agent/` 目录：

- **`sessions/`** — 每会话一个 `<id>.json`（含消息历史与摘要）+ `index.json` 索引
- **`skills/`** — 技能 markdown 文件
- **`todo.json`** — 任务清单，跨会话保留
- **`memory.md`** — 项目级长期记忆，每轮对话自动注入系统提示

建议把 `.agent/` 加入 `.gitignore`。

## 局限性与扩展方向

- 无 gitignore 感知（`grep` 会扫描所有非 `node_modules`/`.git` 文件）
- 无 AST 级别的代码理解，靠文本匹配做编辑
- 端到端真实 API 对话未充分测试（需有效 API key）
- 无并行多 agent 编排
- 安全提示：`run_command` 可执行任意 shell 命令，请勿在不可信环境下对模型放开

可扩展方向：接入 embedding 做语义搜索、加 git diff 工具、加 web 搜索工具、支持 MCP 协议工具、技能按需懒加载。

## License

MIT
