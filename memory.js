// memory.js — 跨会话事实记忆（项目级，所有会话共享）
//
// 与 sessions.js 的区别：
//   sessions 存「对话历史」——会话级，每个会话独立，切换会话就换一份
//   memory  存「长期事实」——项目级，所有会话共享，记住用户偏好、项目知识、
//           关键决定等，重启后自动注入系统提示词，让 agent 跨会话保持一致行为。
//
// 存储：.agent/memory.md，纯 markdown，人类可读可手编。
// 格式：每行一条 `- 内容`，简单列表。模型通过 memory 工具增删查。

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const MEMORY_FILE = path.join(ROOT, ".agent", "memory.md");

// 读取记忆文件，返回字符串数组（每条一行，已去 bullet 前缀和空白）
export async function loadMemory() {
  try {
    const text = await fs.readFile(MEMORY_FILE, "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")) // 跳过空行和标题
      .map((l) => l.replace(/^[-*]\s*/, "")); // 去掉 bullet 前缀
  } catch {
    return [];
  }
}

// 把记忆数组写回文件，每条 `- 内容`，附文件头说明
export async function saveMemory(items) {
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  const body = `# 项目记忆（agent 跨会话共享，可手动编辑）\n\n` +
    items.map((l) => `- ${l}`).join("\n") + "\n";
  await fs.writeFile(MEMORY_FILE, body, "utf8");
}

// 把记忆渲染成可注入系统提示词的字符串块
// 没记忆返回空串，有记忆返回「【项目记忆】...」段
export async function renderMemoryForPrompt() {
  const items = await loadMemory();
  if (!items.length) return "";
  return "\n\n【项目记忆】（跨会话长期事实，优先遵循）\n" +
    items.map((l) => `- ${l}`).join("\n");
}

// 增：追加一条记忆（去重，已存在则跳过）
export async function addMemory(item) {
  const items = await loadMemory();
  const trimmed = item.trim();
  if (!trimmed) return "ERROR: 内容为空";
  if (items.some((l) => l === trimmed)) return "已存在，跳过";
  items.push(trimmed);
  await saveMemory(items);
  return `已记忆: ${trimmed}（共 ${items.length} 条）`;
}

// 删：按关键词删（删所有含该关键词的记忆），返回删除条数
export async function deleteMemory(keyword) {
  const items = await loadMemory();
  const kw = keyword.trim();
  const kept = items.filter((l) => !l.includes(kw));
  const removed = items.length - kept.length;
  if (removed > 0) await saveMemory(kept);
  return `删除 ${removed} 条匹配 "${kw}" 的记忆`;
}

// 查：列出所有记忆，或按关键词过滤
export async function listMemory(keyword) {
  const items = await loadMemory();
  const filtered = keyword ? items.filter((l) => l.includes(keyword)) : items;
  if (!filtered.length) return keyword ? `(无匹配 "${keyword}" 的记忆)` : "(暂无记忆)";
  return filtered.map((l, i) => `${i + 1}. ${l}`).join("\n");
}
