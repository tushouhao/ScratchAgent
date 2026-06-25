// compress.js — 上下文自动压缩
//
// 思路：估算 history 的字符数（粗估 token），超过阈值时把较早的消息
//       调模型摘要成一条 system 消息，保留最近 N 条原始消息不动，
//       两者拼成新 history。这样既省 token 又保留关键上下文。
//
// summaryRef = { text, version } 由 sessions.js 持有并随会话持久化，
// 本模块只读写内存对象的字段，不直接碰磁盘。
//
// 阈值按字符粗估（1 token ≈ 3.5 字符，保守取 3），不引第三方 tokenizer。

import { chat } from "./llm.js";

// 配置（可通过环境变量调）：
//   LM_MAX_CHARS       触发压缩的字符上限，默认 24000
//   LM_KEEP_RECENT     压缩时保留最近多少条原始消息，默认 12
//   LM_SUMMARY_TRIGGER 累积摘要本身超此长度则先对摘要做二次压缩，默认 16000
const MAX_CHARS = Number(process.env.LM_MAX_CHARS || 24000);
const KEEP_RECENT = Number(process.env.LM_KEEP_RECENT || 12);
const SUMMARY_TRIGGER = Number(process.env.LM_SUMMARY_TRIGGER || 16000);

// ---------- 字符数估算 ----------
// 把消息数组展平成纯文本字符数，作为 token 数的保守上限
// content 可能是 string 或其他类型，统一处理；tool_calls 和 tool_call_id 也计入
function estimateChars(messages) {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (m.content) n += JSON.stringify(m.content).length;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
    if (m.tool_call_id) n += 20; // id 本身固定开销
  }
  return n;
}

// ---------- 把一组消息压缩成一段摘要文本 ----------
// 调用 LLM（不带工具）让它产出简洁 markdown 摘要
async function summarize(messages, prevSummary) {
  const prompt = `你是上下文压缩器。把下面的 agent 对话历史压缩成一段简洁的中文 markdown 摘要，
保留：用户意图、已做的决定、已改动的文件及关键改动、待办、重要工具结论。
丢弃：工具输出的冗余细节、重复内容、已废弃的中间尝试。
${prevSummary ? `之前的摘要也要并入（作为已发生事实的背景）：\n${prevSummary}\n` : ""}
只输出摘要正文，不要加标题，不要加任何解释语。

对话历史：
${JSON.stringify(messages.map(stripForSummary), null, 2)}`;

  // 非流式调用：压缩不需要流式，直接拿完整结果
  const reply = await chat(
    [{ role: "user", content: prompt }],
    null, // 不带工具 schema，纯文本调用
    { stream: false },
  );
  return (reply.content || "").trim();
}

// 给摘要输入用的精简版：tool 结果再截一刀，避免摘要输入本身过长
function stripForSummary(m) {
  const cap = 800;
  let content = m.content;
  if (typeof content === "string" && content.length > cap) {
    content = content.slice(0, cap) + "...";
  }
  return { role: m.role, content, name: m.name };
}

// ---------- 主入口：必要时压缩 history，就地修改并返回是否压缩 ----------
// summaryRef = { text, version } 由调用方持有，本函数只改它的字段（不落盘）
// 返回 true 表示发生了压缩，false 表示未触发
export async function maybeCompress(history, summaryRef) {
  const chars = estimateChars(history);
  if (chars <= MAX_CHARS) return false; // 没超阈值，啥也不做

  console.log(`\n[compress] history 约 ${chars} 字符 > 阈值 ${MAX_CHARS}，开始压缩...`);

  // 切分：较早的待压缩部分 + 保留的最近部分
  // 至少留 2 条，避免 keepCount 把历史掏空
  const keepCount = Math.min(KEEP_RECENT, history.length - 2);
  const toCompress = history.slice(0, history.length - keepCount);
  const keep = history.slice(history.length - keepCount);

  if (toCompress.length === 0) {
    // 全是最近消息没东西可压，说明是单条超长消息，跳过
    console.log("[compress] 无可压缩的前段（单条过长），跳过。");
    return false;
  }

  // 二级压缩：摘要本身过长时先把它压一遍，防止摘要无限膨胀
  if (summaryRef.text.length > SUMMARY_TRIGGER) {
    console.log(`[compress] 旧摘要过长(${summaryRef.text.length})，先二次压缩...`);
    summaryRef.text = await summarize(
      [{ role: "system", content: summaryRef.text }],
      "",
    );
  }

  // 压缩：把待压缩部分并入旧摘要，产出新摘要
  const newSummary = await summarize(toCompress, summaryRef.text);
  summaryRef.text = newSummary;
  summaryRef.version = (summaryRef.version || 0) + 1;
  // 摘要落盘交给 sessions.saveSession，这里只改内存对象

  // 就地改 history：清空再回填 [摘要system消息, ...保留的最近消息]
  history.length = 0;
  history.push({
    role: "system",
    content: `【过往对话摘要 v${summaryRef.version}】\n${newSummary}`,
  });
  history.push(...keep);

  console.log(`[compress] 压缩完成：${toCompress.length} 条 → 1 条摘要，保留最近 ${keep.length} 条。现 ${history.length} 条消息，约 ${estimateChars(history)} 字符。`);
  return true;
}

export { estimateChars };
