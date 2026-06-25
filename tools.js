// tools.js — 工具实现，零依赖，纯 Node.js 内置模块
//
// 本文件定义 agent 可调用的全部工具。每个工具是一个对象：
//   {
//     name:        工具名（LLM 用它来调用）
//     description: 给 LLM 看的说明，描述工具做什么
//     parameters:  JSON Schema，描述参数结构（LLM 据此生成参数）
//     run:         async (args, ctx) => string  实际执行函数
//   }
// run 的返回值统一为字符串，作为 tool 消息塞回对话历史。
// ctx = { onOutput } 是可选的实时输出回调，run_command 用它流式打印。

import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { addMemory, deleteMemory, listMemory } from "./memory.js";

// 记录 agent 启动时的工作目录，所有工具的相对路径都以此为基准解析
export const ROOT = process.cwd();

// 任务清单持久化路径：.agent/todo.json
export const TODO_FILE = path.join(ROOT, ".agent", "todo.json");

// ---------- 任务清单内存态（todo 工具用） ----------
// todoStore 是模块级变量，所有 todo 工具调用共享同一份清单
let todoStore = [];

// 从磁盘加载任务清单；文件不存在时返回空数组（首次启动的正常情况）
async function loadTodo() {
  try {
    todoStore = JSON.parse(await fs.readFile(TODO_FILE, "utf8"));
  } catch {
    todoStore = [];
  }
}

// 把清单渲染成人类可读的字符串，每行一个任务，用 [x]/[~]/[ ] 标记状态
function renderTodo() {
  if (!todoStore.length) return "(任务清单为空)";
  return todoStore
    .map((t, i) => `${i + 1}. [${t.status === "done" ? "x" : t.status === "doing" ? "~" : " "}] ${t.content}`)
    .join("\n");
}

// 把当前内存清单写盘，确保跨会话持久化
async function saveTodo() {
  await fs.mkdir(path.dirname(TODO_FILE), { recursive: true });
  await fs.writeFile(TODO_FILE, JSON.stringify(todoStore, null, 2), "utf8");
}
// 模块加载时即读取历史清单，让 todo 状态在重启后自动恢复
await loadTodo();

// ---------- Skills 加载（标准规范） ----------
//
// Skill 文件格式（.md，YAML frontmatter + 结构化正文）：
//
//   ---
//   name: my-skill
//   version: 1.0.0
//   author: Token炼金师
//   description: 一句话说明
//   tags: [git, 提交]
//   args:
//     - name: message
//       description: 自定义提交信息
//       required: false
//   ---
//
//   ## 指令
//   做什么的总体描述
//
//   ## 步骤
//   1. 第一步...
//   2. 第二步...
//
//   ## 验证
//   如何确认执行成功
//
//   ## 示例
//   use_skill("commit", "只提交 docs 改动")
//
// 占位符：{{arguments}} → 用户传入参数, {{cwd}} → 工作目录
//
// 搜索路径（优先级从高到低）：
//   1. 项目级 .agent/skills/*.md
//   2. 全局级 ~/.atomcode/skills/*.md

import os from "node:os";

const SKILLS_DIR_PROJECT = path.join(ROOT, ".agent", "skills");
const SKILLS_DIR_GLOBAL = path.join(os.homedir(), ".atomcode", "skills");

// 解析 YAML frontmatter，支持多字段 + 数组 + 嵌套 args
// 数组格式: tags: [a, b, c]  或  args 列表块
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: "", version: "", author: "", description: "", tags: [], args: [], body: text };

  const raw = m[1];
  const fields = {};
  const argsList = [];

  // 逐行解析简单 key: value 和数组
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) { i++; continue; }
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();

    if (k === "args") {
      // args 是列表块：跳到下一行开始读 - name: ... 块
      i++;
      while (i < lines.length) {
        const al = lines[i];
        // - name: xxx 开头表示新的 arg 项
        const argMatch = al.match(/^\s*-\s+name:\s*(.+)/);
        if (argMatch) {
          const arg = { name: argMatch[1].trim(), description: "", required: false };
          i++;
          // 读取该 arg 的子字段（description:, required:）
          while (i < lines.length) {
            const sl = lines[i];
            if (sl.match(/^\s*-\s+name:/) || !sl.match(/^\s+/)) break; // 下一个 arg 或非子字段
            const dm = sl.match(/^\s+description:\s*(.+)/);
            if (dm) { arg.description = dm[1].trim(); i++; continue; }
            const rm = sl.match(/^\s+required:\s*(.+)/);
            if (rm) { arg.required = rm[1].trim() === "true"; i++; continue; }
            i++;
          }
          argsList.push(arg);
          continue;
        }
        if (!al.match(/^\s+/) && !al.match(/^\s*$/)) break; // 非缩进非空行，退出 args 块
        i++;
      }
      fields.args = argsList;
      continue;
    }

    // tags: [a, b, c] 数组格式
    if (k === "tags" && v.startsWith("[") && v.endsWith("]")) {
      fields[k] = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      fields[k] = v;
    }
    i++;
  }

  return {
    name: fields.name || "",
    version: fields.version || "1.0.0",
    author: fields.author || "",
    description: fields.description || "",
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    args: Array.isArray(fields.args) ? fields.args : [],
    body: m[2],
  };
}

// 从一个目录加载 skills
async function loadSkillsFromDir(dir) {
  let entries;
  try { entries = await fs.readdir(dir); }
  catch { return []; }
  const skills = [];
  for (const f of entries) {
    if (!f.endsWith(".md")) continue;
    let text;
    try { text = await fs.readFile(path.join(dir, f), "utf8"); }
    catch { continue; }
    const parsed = parseFrontmatter(text);
    if (!parsed.name) parsed.name = f.slice(0, -3);
    skills.push({ ...parsed, file: f, dir });
  }
  return skills;
}

// 加载全部 skills：项目级优先，全局级补充（同名以项目级为准）
export async function loadSkills() {
  const project = await loadSkillsFromDir(SKILLS_DIR_PROJECT);
  const global_ = await loadSkillsFromDir(SKILLS_DIR_GLOBAL);
  // 合并：项目级覆盖全局同名 skill
  const names = new Set(project.map((s) => s.name));
  return [...project, ...global_.filter((s) => !names.has(s.name))];
}

// ---------- 工具集合 ----------
// 每个工具: { name, description, parameters(JSON Schema), run }
// run 签名: async (args, ctx) => string；ctx = { onOutput } 可选实时输出回调
export const TOOLS = [
  {
    name: "read_file",
    description: "Read the full content of a file at the given path (relative to cwd). Returns file content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative or absolute." },
      },
      required: ["path"],
    },
    // 读文件全文，返回 utf8 字符串
    async run({ path: p }) {
      const full = path.resolve(ROOT, p); // 相对路径基于 ROOT 解析
      const buf = await fs.readFile(full, "utf8");
      return buf;
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write." },
        content: { type: "string", description: "Full content to write." },
      },
      required: ["path", "content"],
    },
    // 创建或覆盖文件；先递归建父目录，避免目录不存在报错
    async run({ path: p, content }) {
      const full = path.resolve(ROOT, p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      return `Wrote ${content.length} bytes to ${p}`;
    },
  },
  {
    name: "edit_file",
    description: "Replace the first occurrence of `old` with `new` in the file. Fails if `old` not found.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string", description: "Exact text to find (must be unique)." },
        new: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old", "new"],
    },
    // 精确替换：要求 old 在文件中唯一存在，否则报错避免误改多处
    async run({ path: p, old, new: neu }) {
      const full = path.resolve(ROOT, p);
      let text = await fs.readFile(full, "utf8");
      const idx = text.indexOf(old);
      if (idx === -1) return `ERROR: old string not found in ${p}`;
      // 用 split 数出现次数，>1 说明不唯一，拒绝替换
      const count = text.split(old).length - 1;
      if (count > 1) return `ERROR: old string appears ${count} times, not unique in ${p}`;
      // 拼接新内容：前段 + new + 后段
      text = text.slice(0, idx) + neu + text.slice(idx + old.length);
      await fs.writeFile(full, text, "utf8");
      return `Edited ${p}`;
    },
  },
  {
    name: "edit_files",
    description: "Apply multiple edits across several files in parallel. Each edit: {path, old, new}. 'old' must be unique within its file. Returns per-edit status. Use this instead of calling edit_file repeatedly.",
    parameters: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          description: "List of edits to apply concurrently.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              old: { type: "string", description: "Exact text to find (must be unique in the file)." },
              new: { type: "string", description: "Replacement text." },
            },
            required: ["path", "old", "new"],
          },
        },
      },
      required: ["edits"],
    },
    // 并发多文件编辑：跨文件 Promise.all 并发，同文件内多编辑按顺序串行
    // 这样既快又安全——同一文件的多次编辑若并发会互相覆盖读到旧内容
    async run({ edits }) {
      if (!Array.isArray(edits) || !edits.length) return "ERROR: edits is empty";
      // 按文件分组：Map<path, edit[]>
      const byFile = new Map();
      for (const e of edits) {
        if (!byFile.has(e.path)) byFile.set(e.path, []);
        byFile.get(e.path).push(e);
      }
      // 处理单个文件的所有编辑：读取→逐个替换→写回
      const applyOneFile = async (p, list) => {
        const full = path.resolve(ROOT, p);
        let text;
        try { text = await fs.readFile(full, "utf8"); }
        catch (e) { return { path: p, ok: false, error: `read failed: ${e.message}` }; }
        const log = []; // 每个编辑的成功/失败记录
        for (const e of list) {
          const idx = text.indexOf(e.old);
          if (idx === -1) { log.push({ ok: false, error: "old not found" }); continue; }
          if (text.split(e.old).length - 1 > 1) { log.push({ ok: false, error: "old not unique" }); continue; }
          text = text.slice(0, idx) + e.new + text.slice(idx + e.old.length);
          log.push({ ok: true });
        }
        try { await fs.writeFile(full, text, "utf8"); }
        catch (e) { return { path: p, ok: false, error: `write failed: ${e.message}` }; }
        return { path: p, ok: true, edits: log };
      };
      // 跨文件并发执行，每个文件一个 promise
      const tasks = [...byFile.entries()].map(([p, list]) => applyOneFile(p, list));
      const results = await Promise.all(tasks);
      return JSON.stringify(results, null, 2);
    },
  },
  {
    name: "list_dir",
    description: "List entries of a directory (one per line). Directories suffixed with '/'.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path, default cwd.", default: "." },
      },
    },
    // 列目录，目录名后加 / 区分，按名排序
    async run({ path: p = "." }) {
      const full = path.resolve(ROOT, p);
      const entries = await fs.readdir(full, { withFileTypes: true });
      return entries
        .map((e) => e.name + (e.isDirectory() ? "/" : ""))
        .sort()
        .join("\n");
    },
  },
  {
    name: "grep",
    description: "Search file contents by regex. Returns matching lines with file:line: prefix. Gitignore unaware.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regex pattern string." },
        path: { type: "string", description: "Directory or file to search, default cwd.", default: "." },
      },
      required: ["pattern"],
    },
    // 正则搜索文件内容，递归遍历目录，跳过 node_modules 和 .git
    // 返回 file:line: content 格式的匹配行，最多 200 行防爆
    async run({ pattern, path: p = "." }) {
      const root = path.resolve(ROOT, p);
      const re = new RegExp(pattern);
      const results = [];
      // 递归访问目录，对每个文件按行测试正则
      const visit = async (dir) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { return; } // 无权限等错误静默跳过
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git") continue; // 跳过噪音目录
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await visit(full);
          else if (e.isFile()) {
            let text = "";
            try { text = await fs.readFile(full, "utf8"); }
            catch { continue; } // 二进制/无权限文件跳过
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                // 用相对路径显示，更易读
                results.push(`${path.relative(ROOT, full)}:${i + 1}: ${lines[i]}`);
                if (results.length >= 200) return; // 达到上限停止
              }
            }
          }
        }
      };
      // 入参是单个文件就直接搜该文件，是目录则递归
      if (existsSync(root) && statSync(root).isFile()) {
        const text = await fs.readFile(root, "utf8");
        text.split("\n").forEach((line, i) => {
          if (re.test(line)) results.push(`${path.relative(ROOT, root)}:${i + 1}: ${line}`);
        });
      } else {
        await visit(root);
      }
      return results.length ? results.join("\n") : "No matches.";
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in cwd. Streams stdout/stderr live to the console. Returns combined output (truncated to 32KB). Use for builds/tests/git. 60s timeout.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
      },
      required: ["command"],
    },
    // 流式执行 shell 命令：用 spawn 替代 execSync，stdout/stderr 实时打印
    // 通过 ctx.onOutput 回调把输出暴露给上层；60 秒超时强杀进程
    async run({ command }, ctx = {}) {
      return new Promise((resolve) => {
        // shell:true 让命令字符串走系统 shell 解析（支持管道、重定向等）
        const child = spawn(command, {
          cwd: ROOT,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"], // 不接收 stdin，stdout/stderr 管道捕获
          windowsHide: true, // Windows 下不弹窗
        });
        let out = ""; // 累积全部输出，作为返回值
        // 统一处理 stdout/stderr 的数据块：累积 + 实时打印 + 回调
        const onChunk = (label, data) => {
          const s = data.toString();
          out += s;
          process.stdout.write(s); // 实时显示到控制台
          ctx.onOutput?.(label, s); // 通知上层（agent 可据此做额外处理）
        };
        child.stdout.on("data", (d) => onChunk("stdout", d));
        child.stderr.on("data", (d) => onChunk("stderr", d));
        // 60 秒超时：强杀子进程并返回已收集的输出
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          out += "\n[timeout] killed after 60s\n";
          resolve(out.slice(0, 32768) || "(no output)");
        }, 60000);
        // 进程启动失败（如命令不存在）
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve(`Command failed to start: ${e.message}`);
        });
        // 进程结束：按退出码区分成功/失败
        child.on("close", (code) => {
          clearTimeout(timer);
          const body = out || "(no output)";
          if (code === 0) resolve(body.slice(0, 32768));
          else resolve(`Command failed (exit ${code}):\n${body.slice(0, 32768)}`);
        });
      });
    },
  },
  {
    name: "todo",
    description: "Manage a persistent task list that survives across turns and sessions. Actions: 'list' (show all), 'add' (add task, needs content), 'update' (change status by 1-based id, needs id+status), 'clear' (wipe all). status values: pending | doing | done.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "update", "clear"], description: "What to do." },
        content: { type: "string", description: "Task text (for add)." },
        id: { type: "integer", description: "1-based task id (for update)." },
        status: { type: "string", enum: ["pending", "doing", "done"], description: "New status (for update)." },
      },
      required: ["action"],
    },
    // 持久化任务清单：list/add/update/clear 四个动作
    // 数据存内存 todoStore，每次修改后 saveTodo 写盘，跨会话保留
    async run({ action, content, id, status }) {
      switch (action) {
        case "list":
          return renderTodo();
        case "add":
          if (!content) return "ERROR: content required for add";
          todoStore.push({ content, status: "pending" }); // 新任务默认 pending
          await saveTodo();
          return `Added task ${todoStore.length}.\n${renderTodo()}`;
        case "update": {
          // id 是 1-based，校验范围和 status 必填
          if (!id || id < 1 || id > todoStore.length) return `ERROR: id out of range (1..${todoStore.length})`;
          if (!status) return "ERROR: status required for update";
          todoStore[id - 1].status = status;
          await saveTodo();
          return `Updated task ${id}.\n${renderTodo()}`;
        }
        case "clear":
          todoStore = [];
          await saveTodo();
          return "Cleared all tasks.";
        default:
          return `ERROR: unknown action ${action}`;
      }
    },
  },
  {
    name: "list_skills",
    description: "List all available skills with name, version, tags, description, and required args. Skills are reusable workflow templates loaded from .agent/skills/ and ~/.atomcode/skills/. Use use_skill to invoke one.",
    parameters: { type: "object", properties: {} },
    // 列出所有可用 skill，带版本/标签/参数等元信息
    async run() {
      const list = await loadSkills();
      if (!list.length) return "(暂无 skills。在 .agent/skills/ 下放 *.md 文件即可创建)";
      return list.map((s) => {
        const tag = s.tags.length ? ` [${s.tags.join(",")}]` : "";
        const ver = s.version ? ` v${s.version}` : "";
        const reqArgs = s.args.filter((a) => a.required).map((a) => a.name);
        const argHint = reqArgs.length ? ` (必填: ${reqArgs.join(", ")})` : "";
        return `- ${s.name}${ver}${tag}: ${s.description}${argHint}`;
      }).join("\n");
    },
  },
  {
    name: "use_skill",
    description: "Invoke a named skill: reads its structured workflow (instructions → steps → verification) and returns it with {{arguments}}/{{cwd}} substituted. If the skill declares required args, they must be provided.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (from list_skills)." },
        arguments: { type: "string", description: "Arguments string, substituted into {{arguments}} placeholder. For skills with required args, provide them here." },
      },
      required: ["name"],
    },
    // 调用 skill：校验必填参数 → 替换占位符 → 返回结构化工作流指引
    async run({ name, arguments: args = "" }) {
      const list = await loadSkills();
      const skill = list.find((s) => s.name === name);
      if (!skill) return `ERROR: skill '${name}' not found. 用 list_skills 查看。`;

      // 校验必填参数：若 skill 声明了 required args 但 arguments 为空，提示
      const requiredArgs = skill.args.filter((a) => a.required);
      if (requiredArgs.length && !args.trim()) {
        const hint = requiredArgs.map((a) => `  - ${a.name}: ${a.description}`).join("\n");
        return `ERROR: skill '${name}' 需要参数:\n${hint}\n请在 arguments 中提供。`;
      }

      let body = skill.body;
      // 模板替换：{{arguments}} → 用户参数, {{cwd}} → 工作目录
      body = body.replaceAll("{{arguments}}", args).replaceAll("{{cwd}}", ROOT);

      // 构造返回：元信息头 + 正文
      const meta = [];
      meta.push(`【skill: ${name}】`);
      if (skill.version) meta.push(`版本: ${skill.version}`);
      if (skill.author) meta.push(`作者: ${skill.author}`);
      if (skill.tags.length) meta.push(`标签: ${skill.tags.join(", ")}`);
      if (skill.args.length) {
        meta.push("参数:");
        for (const a of skill.args) {
          meta.push(`  - ${a.name}${a.required ? "(必填)" : "(可选)"}: ${a.description}`);
        }
      }
      return meta.join("\n") + "\n\n" + body;
    },
  },
  {
    name: "memory",
    description: "Manage cross-session long-term memory (project-level, shared by all sessions). Persist user preferences, project conventions, key decisions to .agent/memory.md. Actions: 'list' (show all, optional keyword filter), 'add' (append a fact, needs content), 'delete' (remove all entries containing keyword, needs keyword). Memory is auto-injected into system prompt every turn, so prefer adding stable facts over transient ones.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "delete"], description: "What to do." },
        content: { type: "string", description: "Fact text to remember (for add). One concise line, e.g. '用户偏好用 tabs 缩进'." },
        keyword: { type: "string", description: "Filter keyword (for list) or delete criterion (for delete)." },
      },
      required: ["action"],
    },
    // 跨会话事实记忆：模型可自主增删查，记下用户偏好/项目知识/关键决定
    // 启动时记忆会拼进系统提示词，所以每轮对话 agent 都能看到这些长期事实
    async run({ action, content, keyword }) {
      switch (action) {
        case "list":
          return await listMemory(keyword);
        case "add":
          if (!content) return "ERROR: content required for add";
          return await addMemory(content);
        case "delete":
          if (!keyword) return "ERROR: keyword required for delete";
          return await deleteMemory(keyword);
        default:
          return `ERROR: unknown action ${action}`;
      }
    },
  },
];

// 工具查找表：name → tool 对象，callTool 用它快速定位
export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// 给 LLM 用的 schema 数组：去掉 run 函数，只留 name/description/parameters
// 这个数组会传给 chat 接口的 tools 字段，模型据此决定调哪个工具、怎么传参
export const TOOL_SCHEMAS = TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

// 执行工具的统一入口：按 name 查工具，捕获异常返回字符串
// 任何工具内部抛错都被 catch 转成 ERROR: 文本，让模型能看到错误并自行修正
export async function callTool(name, args, ctx) {
  const tool = TOOL_MAP.get(name);
  if (!tool) return `ERROR: unknown tool ${name}`;
  try {
    const result = await tool.run(args ?? {}, ctx ?? {});
    // 非 string 结果（如对象）转 JSON 字符串，保证返回值统一是 string
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}
