// llm.js — 调用大模型，OpenAI 兼容接口（原生 fetch，零依赖）
// 支持流式输出文本 + function calling（工具调用）
//
// 环境变量配置（LM_ 前缀优先于 LLM_ 前缀）:
//   LM_BASE_URL / LLM_BASE_URL  接口地址，默认 OpenAI
//   LM_API_KEY  / LLM_API_KEY   API Key（必填）
//   LM_MODEL    / LLM_MODEL     模型名，默认 gpt-4o-mini

import { renderMemoryForPrompt } from "./memory.js";

// 接口地址：可指向任意 OpenAI 协议兼容服务（DeepSeek/智谱/Ollama/vLLM 等）
const BASE_URL = process.env.LM_BASE_URL || process.env.LLM_BASE_URL || "";
// API Key，缺则启动时告警
const API_KEY = process.env.LM_API_KEY || process.env.LLM_API_KEY || "";
// 模型名
const MODEL = process.env.LM_MODEL || process.env.LLM_MODEL || "LongCat-2.0-Preview";

if (!API_KEY) {
  console.error("[llm] 缺少 API key。请设置环境变量 LLM_API_KEY 或 LM_API_KEY。");
  console.error("[llm] 可同时设置 LM_BASE_URL (兼容接口地址) 和 LM_MODEL (模型名)。");
}

// 系统提示词基础部分：定义 agent 的行为准则
// 每次调用 chat 时会动态拼入当前记忆，保证记忆更新后下一轮就能看到
const SYSTEM_PROMPT_BASE = `你是一个运行在本地的 AI 编程助手（coding agent）。
你通过调用工具来完成用户的编程任务：读写文件、搜索代码、运行命令等。

工作原则:
1. 先观察再动手：用 read_file / list_dir / grep 了解现状，再修改。
2. 修改用最小变更：能用 edit_file 就别 write_file 整个重写。
3. 多个独立改动用 edit_files 并发，比多次 edit_file 快得多。
4. 复杂任务先 todo 列清单，分步推进，每步做完及时 update 状态。
5. 修改后验证：能跑测试或编译就 run_command 跑一遍（输出会实时显示）。
6. 工具结果就是事实，不要臆测文件内容。
7. 简短回答：完成任务后用一两句话说明做了什么，不要复述工具输出。
8. 中文提问用中文答，英文提问用英文答。
9. 有合适的 skill 时优先 use_skill 复用，比从零开始更稳；不确定有哪些就先 list_skills。
10. 用户偏好、项目约定、关键决定等长期事实，用 memory 工具记下来，跨会话复用。

工作目录: ${process.cwd()}`;

// 动态系统提示词：基础部分 + 当前记忆（记忆为空则不加段）
async function buildSystemPrompt() {
  const mem = await renderMemoryForPrompt();
  return SYSTEM_PROMPT_BASE + mem;
}

// 调用 LLM 的统一入口
// messages:    对话历史数组（不含 system，本函数会自动前置 SYSTEM_PROMPT）
// toolSchemas: 工具 schema 数组；传 null/空 则不带 tools 字段（用于纯文本调用如压缩）
// options:     { stream: 是否流式, onToken: 流式 token 回调 }
// 返回: { role, content, tool_calls } —— OpenAI 消息格式
export async function chat(messages, toolSchemas, { stream = true, onToken } = {}) {
  // 动态构造系统提示词：基础 + 当前记忆（每轮调用都重新读，记忆更新即时生效）
  const systemPrompt = await buildSystemPrompt();
  // 构造请求体：system 提示词 + 用户消息历史
  const body = {
    model: MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature: 0.3, // 低温度保证输出稳定可预测
  };
  // 仅在有 schema 时声明 tools，避免压缩用的纯文本调用被某些服务拒绝
  if (toolSchemas?.length) {
    body.tools = toolSchemas;
    body.tool_choice = "auto"; // 让模型自主决定是否调用工具
  }
  if (stream) body.stream = true;

  // 发起请求（用原生 fetch，Node 18+ 内置，零依赖）
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  // 非 2xx 报错，把响应体截断后抛出供上层 catch
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LLM API ${res.status}: ${txt.slice(0, 500)}`);
  }

  // 非流式：直接读完整 JSON 返回 message 对象
  if (!stream) {
    const data = await res.json();
    return data.choices[0].message;
  }

  // ---- 流式解析：逐行读 SSE，累积 content 和 tool_calls ----
  // SSE 格式：每行 data: <json>，最后 data: [DONE]
  // 难点：tool_calls 的 arguments 是分片到达的，需按 index 累积拼接
  let content = "";
  const toolCalls = {}; // index -> { id, name, arguments }，用对象按 index 聚合
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ""; // 跨 chunk 的不完整行缓冲

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // 按换行切分，最后一段可能不完整，留在 buffer 下轮处理
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue; // 只认 data: 行
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") continue; // 流结束标记
      let json;
      try { json = JSON.parse(payload); } catch { continue; } // 解析失败跳过
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      // 文本增量：累积 + 实时回调打印
      if (delta.content) {
        content += delta.content;
        onToken?.(delta.content);
      }
      // 工具调用增量：按 index 聚合，id/name/arguments 分别累积
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id ?? "", name: "", arguments: "" };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments; // 分片拼接
        }
      }
    }
  }

  // 把累积的 toolCalls 对象转成数组，按 index 升序排列
  const calls = Object.keys(toolCalls)
    .sort((a, b) => +a - +b)
    .map((k) => ({
      id: toolCalls[k].id,
      type: "function",
      function: {
        name: toolCalls[k].name,
        arguments: toolCalls[k].arguments,
      },
    }));

  // 返回标准 assistant 消息格式；无工具调用时 tool_calls 为 undefined
  return {
    role: "assistant",
    content: content || null,
    tool_calls: calls.length ? calls : undefined,
  };
}

export { MODEL };
