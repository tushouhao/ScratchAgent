#!/usr/bin/env node
// index.js — 交互式 REPL 入口，多会话管理
//
// 启动时恢复或新建当前会话，进入 readline REPL 循环。
// 支持斜杠命令管理会话，普通输入则交给 agent 处理。
// 输入 / 时自动显示命令下拉提示，Tab 可补全。

import * as readline from "node:readline/promises";
import readlineCb from "node:readline"; // 回调版，提供 emitKeypressEvents
import { stdin, stdout } from "node:process";
import { runAgent } from "./agent.js";
import { MODEL } from "./llm.js";
import { loadSkills } from "./tools.js";
import { loadMemory } from "./memory.js";
import {
  getOrCreateCurrentSession,
  listSessions,
  createSession,
  switchSession,
  renameSession,
  deleteSession,
} from "./sessions.js";

// 当前会话的内存态：history 和 summaryRef 是可变引用，agent 直接改它们
let session = await getOrCreateCurrentSession();
let history = session.messages || [];
let summaryRef = session.summary || { text: "", version: 0 };

// ---------- ANSI 颜色辅助 ----------
const C = {
  gold:  (s) => `\x1b[38;5;220m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[38;5;123m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
};

// ---------- 屏幕宽度 + 横线 ----------
function screenWidth() { return stdout.columns || 80; }
function hr() { return "─".repeat(screenWidth()); }

// ---------- 斜杠命令提示系统 ----------
const COMMANDS = [
  { name: "/sessions", desc: "列出所有会话",     args: "" },
  { name: "/new",      desc: "新建会话",         args: "" },
  { name: "/switch",   desc: "切换到指定会话",   args: " <id>" },
  { name: "/rename",   desc: "重命名当前会话",   args: " <名>" },
  { name: "/delete",   desc: "删除指定会话",     args: " <id>" },
  { name: "/skills",   desc: "列出可用技能",     args: "" },
  { name: "/memory",   desc: "查看记忆(可过滤)", args: " [关键词]" },
  { name: "/clear",    desc: "清空当前会话历史", args: "" },
  { name: "/exit",     desc: "退出",             args: "" },
];

// Tab 补全：readline 的 completer 接口
function completer(line) {
  if (!line.startsWith("/")) return [[], line];
  const hits = COMMANDS
    .filter((c) => (c.name + c.args).startsWith(line))
    .map((c) => c.name + c.args);
  // 有匹配就只列匹配项，无匹配列全部
  return [hits.length ? hits : COMMANDS.map((c) => c.name + c.args), line];
}

// 下拉提示状态：
//   hintActive    — 是否正在显示提示
//   hintMatches   — 当前匹配的命令列表
//   selectedIdx   — 当前选中项索引（-1 表示无选中，纯提示模式）
// 用 DECSC/DECRC（\x1b 7 / \x1b 8）保存恢复光标，比手动计数 A/B 可靠。
let hintActive = false;
let hintMatches = [];
let selectedIdx = -1;

// 渲染下拉提示：在当前光标下方显示匹配 prefix 的命令列表，带选中高亮
// 思路：保存光标 → 换行到下方 → 写提示行（选中项高亮）→ 恢复光标
// 统一写 stdout（和 readline 同流），避免 stderr/stdout 双流光标不同步。
function renderHints() {
  // 先擦掉旧提示
  eraseHintLines();

  const matches = hintMatches;
  if (!matches.length) return;

  // 渲染每条提示行：选中项用 ▶ + 高亮反色，未选中用空格 + 普色
  const lines = matches.map((c, i) => {
    const sel = i === selectedIdx;
    const marker = sel ? "▶" : " ";
    const body = ` ${marker} ${c.name}${c.args.padEnd(12)} — ${c.desc}`;
    return sel ? `\x1b[7m${body}\x1b[0m` : `\x1b[2m${body}\x1b[0m`;
  });

  process.stdout.write("\x1b 7");       // DECSC: 保存光标
  process.stdout.write("\n");           // 下移一行到提示区
  for (const l of lines) {
    process.stdout.write("\x1b[2K");    // 先擦净本行（防残留）
    process.stdout.write(l + "\n");     // 写提示行并换行
  }
  hintActive = true;
  process.stdout.write("\x1b 8");       // DECRC: 恢复光标到输入行
}

// 显示提示（重新计算匹配项，默认不选中）
function showHints(prefix) {
  hintMatches = COMMANDS.filter((c) => c.name.startsWith(prefix));
  selectedIdx = -1;
  renderHints();
}

// 仅擦除提示行（不清状态），用于重绘前清屏
function eraseHintLines() {
  if (!hintActive) return;
  process.stdout.write("\x1b 7");                 // 保存光标
  process.stdout.write("\n");                     // 下移到提示区首行
  process.stdout.write("\x1b[J");                 // 擦到屏幕尾（清掉所有提示行）
  process.stdout.write("\x1b 8");                 // 恢复光标到输入行
  hintActive = false;
}

// 完全关闭提示：擦行 + 清状态
function clearHints() {
  eraseHintLines();
  hintMatches = [];
  selectedIdx = -1;
}

// 选中当前高亮项：把命令名填入 readline 输入行，关闭提示
function acceptSelection() {
  if (selectedIdx < 0 || selectedIdx >= hintMatches.length) return false;
  const cmd = hintMatches[selectedIdx];
  // 用 readline 内部方法把输入行替换为命令名（含末尾空格，方便接参数）
  rl.write(null, { ctrl: true, name: "u" }); // 先清空当前输入行
  rl.write(cmd.name);                          // 写入命令名
  clearHints();
  return true;
}

// ---------- 创建 readline（单实例，带 completer） ----------
const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "> ", completer });

// 监听 keypress 事件：输入 / 时显示提示，↑↓ 选择，Enter 确认选中项，Esc 关闭
// readline 启用 raw mode 后 stdin 会发射 keypress 事件
readlineCb.emitKeypressEvents(stdin);
stdin.on("keypress", (str, key) => {
  // 只在 readline 等待输入时处理（agent 运行中不处理）
  if (!stdin.isRaw) return;
  if (!key) return;

  // 提示处于激活状态时，处理选择键
  if (hintActive && hintMatches.length) {
    // ↑ 上移选中项（循环）
    if (key.name === "up") {
      selectedIdx = (selectedIdx - 1 + hintMatches.length) % hintMatches.length;
      renderHints();
      return;
    }
    // ↓ 下移选中项（循环）
    if (key.name === "down") {
      selectedIdx = (selectedIdx + 1) % hintMatches.length;
      renderHints();
      return;
    }
    // Enter：有选中项则确认填入输入行（不提交），无选中则按原逻辑提交
    if (key.name === "return") {
      if (selectedIdx >= 0) {
        acceptSelection();
        return; // 不让 readline 换行，留在输入行继续编辑
      }
      // 无选中项，擦提示让 readline 正常提交
      clearHints();
      return;
    }
    // Tab：选中第一个匹配项（快捷确认）
    if (key.name === "tab") {
      if (selectedIdx < 0) selectedIdx = 0;
      acceptSelection();
      return;
    }
    // Esc 或 Ctrl+C：关闭提示，留在输入行
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      clearHints();
      return;
    }
  }

  // 回车键：readline 即将换行提交，必须在换行前擦掉提示，
  // 否则换行后光标已下移，再擦会错位/残留
  if (key.name === "return") {
    clearHints();
    return;
  }

  // 其他字符键：等 readline 更新 rl.line 后，按新内容重显提示
  process.nextTick(() => {
    const line = rl.line || "";
    if (line.startsWith("/")) {
      showHints(line);
    } else {
      clearHints();
    }
  });
});

// readline 关闭标志，防止 close 后再调 prompt
let closed = false;

// 统一的 prompt 显示：上横线 + prompt
function showPrompt() {
  if (closed) return;
  console.log(hr());
  try { rl.prompt(); } catch { closed = true; }
}

// ---------- 启动横幅：Logo + 系统信息 ----------
const skills = await loadSkills();
const memItems = await loadMemory();

const LOGO = `
${C.gold("  ╔═════════════════════════════════════════════════════════╗")}
${C.gold("  ║")}${C.cyan("                                                           ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("       ████████╗ ██████╗ ████████╗████████╗███████╗██████╗  ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("       ╚══██╔══╝██╔═══██╗╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗ ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("          ██║   ██║   ██║   ██║      ██║   █████╗  ██████╔╝ ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("          ██║   ██║   ██║   ██║      ██║   ██╔══╝  ██╔═══╝  ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("          ██║   ╚██████╔╝   ██║      ██║   ███████╗██║      ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("          ╚═╝    ╚═════╝    ╚═╝      ╚═╝   ╚══════╝╚═╝      ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("                                                           ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("              ⚗  T o k e n 炼 金 师  ⚗                    ")}${C.gold("║")}
${C.gold("  ║")}${C.cyan("                                                           ")}${C.gold("║")}
${C.gold("  ╚═════════════════════════════════════════════════════════╝")}
`;

console.log(LOGO);
console.log(`${C.dim("  模型:")} ${MODEL}`);
console.log(`${C.dim("  工作目录:")} ${process.cwd()}`);
console.log(`${C.dim("  Skills:")} ${skills.length ? skills.map((s) => s.name).join(", ") : "(无)"}`);
console.log(`${C.dim("  记忆:")} ${memItems.length ? `${memItems.length} 条` : "(无)"}`);
console.log(`${C.dim("  当前会话:")} ${session.id} (${session.name})`);
console.log(`${C.dim("  命令:")} 输入问题开始 | /sessions | /new | /switch <id> | /rename <名> | /delete <id> | /skills | /memory | /clear | /exit\n`);
showPrompt();

// 切换会话后刷新三个内存引用
function refreshSession(s) {
  session = s;
  history = s.messages || [];
  summaryRef = s.summary || { text: "", version: 0 };
}

rl.on("line", async (line) => {
  // 回车时先擦除下拉提示，再打印下横线
  clearHints();
  console.log(hr());
  const input = line.trim();
  if (!input) return showPrompt();

  // ---------- 斜杠命令 ----------
  if (input === "/exit") return rl.close();

  if (input === "/clear") {
    history.length = 0;
    summaryRef.text = "";
    summaryRef.version = 0;
    console.log("当前会话历史已清空。");
    return showPrompt();
  }

  if (input === "/sessions") {
    const list = await listSessions();
    if (!list.length) {
      console.log("(暂无会话)");
    } else {
      console.log("id                           | name              | updatedAt          ");
      console.log("-----------------------------|-------------------|--------------------");
      for (const s of list) {
        const cur = s.id === session.id ? "*" : " ";
        console.log(`${cur} ${s.id.padEnd(27)} | ${(s.name || "").slice(0, 17).padEnd(17)} | ${s.updatedAt || ""}`);
      }
    }
    return showPrompt();
  }

  if (input === "/new") {
    const s = await createSession();
    refreshSession(s);
    console.log(`已新建会话: ${s.id}`);
    return showPrompt();
  }

  const switchMatch = input.match(/^\/switch\s+(\S+)/);
  if (switchMatch) {
    const s = await switchSession(switchMatch[1]);
    if (!s) {
      console.log(`会话 ${switchMatch[1]} 不存在。用 /sessions 查看。`);
    } else {
      refreshSession(s);
      console.log(`已切换到会话: ${s.id} (${s.name})，恢复 ${history.length} 条消息`);
      if (summaryRef.text) console.log(`摘要 v${summaryRef.version}（${summaryRef.text.length} 字符）已恢复`);
    }
    return showPrompt();
  }

  const renameMatch = input.match(/^\/rename\s+(.+)$/);
  if (renameMatch) {
    const ok = await renameSession(session.id, renameMatch[1].trim());
    session.name = renameMatch[1].trim();
    console.log(ok ? `已重命名为: ${session.name}` : "重命名失败");
    return showPrompt();
  }

  const deleteMatch = input.match(/^\/delete\s+(\S+)/);
  if (deleteMatch) {
    const target = deleteMatch[1];
    await deleteSession(target);
    if (target === session.id) {
      const s = await getOrCreateCurrentSession();
      refreshSession(s);
      console.log(`已删除当前会话，切到: ${s.id} (${s.name})`);
    } else {
      console.log(`已删除会话 ${target}`);
    }
    return showPrompt();
  }

  if (input === "/skills") {
    const list = await loadSkills();
    if (!list.length) console.log("(暂无 skills。在 .agent/skills/ 下创建 *.md)");
    else for (const s of list) console.log(`- ${s.name}: ${s.description}`);
    return showPrompt();
  }

  const memMatch = input.match(/^\/memory(?:\s+(.+))?$/);
  if (memMatch) {
    const list = await loadMemory(memMatch[1]?.trim());
    console.log(list);
    return showPrompt();
  }

  // ---------- 普通对话 ----------
  try {
    await runAgent({ id: session.id, history, summaryRef }, input);
  } catch (e) {
    console.error(`\n[error] ${e.message}`);
  }
  console.log();
  showPrompt();
});

rl.on("close", () => {
  closed = true;
  console.log("\nbye.");
  process.exit(0);
});
