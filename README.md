# AtomCode Mini

> 零依赖、纯 Node.js 内置模块手搓的 AI Coding Agent。

不依赖任何第三方库（无 openai SDK、无 langchain、无 commander），仅用 Node 18+ 原生 `fetch` / `readline` / `child_process` / `fs` 实现一个能读写文件、搜索代码、运行命令、管理任务、跨会话记忆的命令行编程助手。

## 特性

- **零依赖** — `npm install` 都不用，开箱即跑
- **流式输出** — 思考文本与命令输出实时打印，不等整段返回
- **Function Calling** — 通过 OpenAI 兼容协议调用工具，ReAct 循环驱动
- **多文件并发编辑** — `edit_files` 跨文件并行，同文件内顺序串行
- **跨会话记忆** — 对话历史与任务清单持久化到 `.agent/`，重启自动恢复
- **任务清单** — 内置 `todo` 工具，模型自主管理多步任务进度
- **兼容任意 OpenAI 协议服务** — OpenAI / DeepSeek / 智谱 / 本地 Ollama / vLLM 等

## 快速开始

### 环境要求

- Node.js ≥ 18（用了原生 `fetch` 和 ESM）

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
| `LM_BASE_URL` / `LLM_BASE_URL` | OpenAI 兼容接口地址 | `https://api.openai.com/v1` |
| `LM_MODEL` / `LLM_MODEL` | 模型名 | `gpt-4o-mini` |

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

## 使用

启动后进入交互式 REPL：

```
AtomCode Mini — 零依赖 AI Coding Agent
模型: deepseek-chat
工作目录: D:\myproject
命令: 输入问题开始 | /history 看历史 | /memory 看记忆文件 | /clear 清历史 | /exit 退出

you> 看一下当前目录有什么项目
you> 用 Python 写一个快速排序存到 sort.py 并跑测试
you> 把 tools.js 里的 grep 改成默认大小写不敏感
```

### REPL 命令

| 命令 | 作用 |
|---|---|
| `/history` | 查看当前会话历史消息 |
| `/memory` | 查看持久化记忆文件内容（保存时间、最近输入/回复） |
| `/clear` | 清空内存中的历史 |
| `/exit` | 退出 |

## 工具一览

Agent 通过以下 8 个工具完成任务：

| 工具 | 说明 |
|---|---|
| `read_file` | 读取文件全文 |
| `write_file` | 创建/覆盖文件，自动建目录 |
| `edit_file` | 精确替换（要求 `old` 在文件内唯一） |
| `edit_files` | **并发**多文件多处编辑，每处独立报告成功/失败 |
| `list_dir` | 列目录（目录后缀 `/`） |
| `grep` | 正则搜索文件内容，跳过 `node_modules` / `.git` |
| `run_command` | 执行 shell 命令，**流式**实时输出 stdout/stderr，60s 超时 |
| `todo` | 管理持久化任务清单（`list` / `add` / `update` / `clear`） |

## 工作原理

```
用户输入
   │
   ▼
┌───────────────┐   无工具调用   ┌──────────┐
│  调用 LLM     │ ───────────► │ 输出回答  │ → 保存记忆 → 结束
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
                           └───► 回到「调用 LLM」（最多 25 轮）
```

核心是 **ReAct 循环**：模型思考 → 调用工具 → 观察结果 → 再思考，直到给出最终回答。设了 `MAX_STEPS=25` 防止死循环。

## 项目结构

```
atomcode-mini/
├── index.js       # REPL 入口，加载记忆、处理命令
├── agent.js       # ReAct 循环，并发执行工具
├── llm.js         # 流式调用 LLM，解析 tool_calls 分片
├── tools.js       # 8 个工具实现 + JSON Schema
├── memory.js      # 跨会话历史持久化
├── package.json   # 零依赖声明
└── .agent/        # 运行时自动生成
    ├── history.json   # 对话历史
    └── todo.json      # 任务清单
```

| 文件 | 行数 | 职责 |
|---|---|---|
| `tools.js` | ~280 | 8 个工具实现 + Schema 定义 |
| `llm.js` | ~120 | OpenAI 兼容协议调用、流式 SSE 解析、系统提示 |
| `agent.js` | ~70 | ReAct 循环、并发工具执行、记忆保存 |
| `memory.js` | ~50 | 历史读写、长消息截断、最近 50 条滚动 |
| `index.js` | ~60 | readline REPL、命令路由、启动恢复 |

## 持久化数据

运行时会在工作目录下生成 `.agent/` 目录：

- **`history.json`** — 最近 50 条消息（超出截断每条 2000 字），下次启动自动恢复上下文
- **`todo.json`** — 任务清单，跨会话保留

建议把 `.agent/` 加入 `.gitignore`。

## 局限性与扩展方向

- 无 gitignore 感知（`grep` 会扫描所有非 `node_modules`/`.git` 文件）
- 无 AST 级别的代码理解，靠文本匹配做编辑
- 历史压缩是最简单的 LRU 截断，未做摘要合并
- 无并行多 agent 编排
- 安全提示：`run_command` 可执行任意 shell 命令，请勿在不可信环境下对模型放开

可扩展方向：接入 embedding 做语义搜索、加 git diff 工具、加 web 搜索工具、做历史摘要压缩、支持 MCP 协议工具。

## License

MIT
