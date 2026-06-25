// sessions.js — 多会话管理
//
// 每个会话独立存 .agent/sessions/<id>.json，结构：
//   {
//     id, name, createdAt, updatedAt,    // 元信息
//     lastInput, lastReply,              // 最近一轮的输入输出（用于展示）
//     messages,                          // 对话历史（最近 MAX_TURNS 条）
//     summary: { text, version }         // 压缩摘要状态
//   }
// 同时维护 .agent/sessions/index.json 记录所有会话的元信息列表 + current 指针，
// 避免每次列会话都要扫目录读所有文件。
//
// 会话 id 用时间戳+随机串生成，保证唯一；name 默认用首条用户输入截断。

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, ".agent", "sessions");
const INDEX_FILE = path.join(DIR, "index.json");

// 每会话最多保留最近消息条数，超出截断（老的已被摘要吸收，丢掉无碍）
const MAX_TURNS = 50;

// ---------- 工具函数 ----------
// 单条消息瘦身：超长 content 截断到 cap，附截断提示，防爆 context
function slim(msg, cap = 2000) {
  if (typeof msg.content === "string" && msg.content.length > cap) {
    return { ...msg, content: msg.content.slice(0, cap) + `\n...(truncated ${msg.content.length - cap} chars)` };
  }
  return msg;
}

// 生成会话 id：时间戳(36进制) + 4 位随机，足够短且唯一
function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// 会话 id → 文件路径
function sessionFile(id) {
  return path.join(DIR, `${id}.json`);
}

// ---------- 索引管理 ----------
// 索引存 { sessions: [元信息...], current: id }
async function loadIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX_FILE, "utf8"));
  } catch {
    return { sessions: [], current: null }; // 文件不存在返回空索引
  }
}

async function saveIndex(idx) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(INDEX_FILE, JSON.stringify(idx, null, 2), "utf8");
}

// 列出所有会话元信息（不含 messages），按 updatedAt 降序（最近用的在前）
export async function listSessions() {
  const idx = await loadIndex();
  return (idx.sessions || []).slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

// 获取当前会话 id（启动时用）
export async function getCurrentSessionId() {
  const idx = await loadIndex();
  return idx.current || null;
}

// ---------- 会话 CRUD ----------
// 加载完整会话（含 messages + summary）；不存在返回 null
export async function loadSession(id) {
  if (!id) return null;
  try {
    const data = JSON.parse(await fs.readFile(sessionFile(id), "utf8"));
    return data;
  } catch {
    return null;
  }
}

// 创建新会话，返回完整会话对象（messages/summary 是空初始态）
// 同时把它加入索引并设为 current
export async function createSession(name = "") {
  const id = newId();
  const now = new Date().toISOString();
  const session = {
    id,
    name: name || "(empty)", // �给名字就占位，首次对话后会用首条输入更新
    createdAt: now,
    updatedAt: now,
    lastInput: "",
    lastReply: "",
    messages: [],
    summary: { text: "", version: 0 },
  };
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(sessionFile(id), JSON.stringify(session, null, 2), "utf8");

  // 更新索引：加元信息 + 设为 current
  const idx = await loadIndex();
  idx.sessions = idx.sessions || [];
  idx.sessions.push({ id, name: session.name, createdAt: now, updatedAt: now });
  idx.current = id;
  await saveIndex(idx);

  return session;
}

// 切换当前会话：加载完整对象并更新 current 指针；不存在返回 null
export async function switchSession(id) {
  const s = await loadSession(id);
  if (!s) return null;
  const idx = await loadIndex();
  idx.current = id;
  await saveIndex(idx);
  return s;
}

// 重命名会话：更新会话文件和索引中的元信息
export async function renameSession(id, name) {
  const s = await loadSession(id);
  if (!s) return false;
  s.name = name;
  s.updatedAt = new Date().toISOString();
  await fs.writeFile(sessionFile(id), JSON.stringify(s, null, 2), "utf8");
  // 同步更新索引里的元信息
  const idx = await loadIndex();
  const meta = (idx.sessions || []).find((m) => m.id === id);
  if (meta) { meta.name = name; meta.updatedAt = s.updatedAt; }
  await saveIndex(idx);
  return true;
}

// 删除会话：删文件 + 从索引移除；删的是 current 则清空 current 指针
export async function deleteSession(id) {
  try { await fs.unlink(sessionFile(id)); } catch {} // 文件不存在也无所谓
  const idx = await loadIndex();
  idx.sessions = (idx.sessions || []).filter((m) => m.id !== id);
  if (idx.current === id) idx.current = null;
  await saveIndex(idx);
  return true;
}

// 保存会话：更新 messages + summary + 元信息，写回文件和索引
// agent 每轮结束调一次，把当前 history 和 summary 持久化
export async function saveSession(id, history, summaryRef, userInput, finalReply) {
  const s = await loadSession(id);
  if (!s) return false;
  s.updatedAt = new Date().toISOString();
  // 有新输入就更新 lastInput；若 name 还是占位就用首条输入截断命名
  if (userInput) {
    s.lastInput = userInput;
    if (!s.name || s.name === "(empty)") {
      s.name = userInput.slice(0, 30) || "(empty)";
    }
  }
  if (finalReply) s.lastReply = finalReply;
  // 只保留最近 MAX_TURNS 条，每条 slim 防爆
  s.messages = history.slice(-MAX_TURNS).map((m) => slim(m));
  s.summary = { ...summaryRef }; // 摘要状态浅拷贝存盘
  await fs.writeFile(sessionFile(id), JSON.stringify(s, null, 2), "utf8");

  // 同步索引里的 name 和 updatedAt
  const idx = await loadIndex();
  const meta = (idx.sessions || []).find((m) => m.id === id);
  if (meta) { meta.name = s.name; meta.updatedAt = s.updatedAt; }
  await saveIndex(idx);
  return true;
}

// 启动时获取要恢复的会话：优先 current 指向的；不存在或没 current 则新建
export async function getOrCreateCurrentSession() {
  const idx = await loadIndex();
  if (idx.current) {
    const s = await loadSession(idx.current);
    if (s) return s;
  }
  // current 指向的文件没了或没 current，新建一个
  return await createSession();
}
