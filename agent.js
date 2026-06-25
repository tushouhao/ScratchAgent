// agent.js — ReAct 循环核心：模型思考 → 调用工具 → 观察结果 → 再思考 ...
//
// ReAct = Reasoning + Acting，让模型在「想」和「做」之间反复切换：
// 每轮模型要么直接回答（无 tool_calls），要么调用工具（有 tool_calls），
// 后者把工具结果塞回历史，下一轮模型基于结果继续，直到不再调工具。

import { chat } from "./llm.js";
import { TOOL_SCHEMAS, callTool } from "./tools.js";
import { saveSession } from "./sessions.js";
import { maybeCompress } from "./compress.js";
import { startSpinner } from "./spinner.js";

// 单次任务的最大工具调用轮数，防止模型死循环无限调工具
const MAX_STEPS = 25;

// 运行一个回合：用户输入 → 多步工具调用 → 最终回复
// session = { id, history, summaryRef } 由 index.js 维护并传入：
//   - id:         当前会话 id，用于结束时保存
//   - history:    对话历史数组（可变引用，本函数直接 push）
//   - summaryRef: 压缩摘要状态（可变引用，maybeCompress 会改它）
export async function runAgent(session, userInput, onToken) {
  const { id, history, summaryRef } = session;
  // 先把用户输入加入历史
  history.push({ role: "user", content: userInput });

  for (let step = 0; step < MAX_STEPS; step++) {
    // 每轮调模型前检查是否需要压缩上下文（超阈值就摘要旧消息）
    await maybeCompress(history, summaryRef);

    // 调模型，流式打印思考文本到控制台
    // 思考等待期显示旋转动画，首个 token 一到就停动画让位给流式文本
    const spinner = startSpinner(step === 0 ? "思考中" : `再思考 (step ${step + 1}/${MAX_STEPS})`);
    let spinnerStopped = false;
    const reply = await chat(history, TOOL_SCHEMAS, {
      stream: true,
      onToken: (t) => {
        if (!spinnerStopped) { spinner.stop(); spinnerStopped = true; } // 首个 token 停动画
        process.stdout.write(t);
        onToken?.(t); // 上层（如 GUI）也可拿 token 流
      },
    });
    // 兜底：若全程无 token（纯 tool_calls 调用），也要停动画
    if (!spinnerStopped) spinner.stop();
    history.push(reply); // 模型回复入历史

    // 没有工具调用 → 模型已给出最终回答，本轮结束
    if (!reply.tool_calls?.length) {
      console.log();
      // 把这一轮的对话和摘要写盘，跨会话恢复
      await saveSession(id, history, summaryRef, userInput, reply.content || "");
      return;
    }

    // 有工具调用 → 并发执行所有调用，结果各自作为 tool 消息塞回历史
    // 同一轮内多个工具调用通常互不依赖，Promise.all 并发可省一半时间
    const ctx = { onOutput: (label, s) => process.stdout.write(s) }; // 给 run_command 流式用
    const pending = reply.tool_calls.map(async (call) => {
      const name = call.function.name;
      // 模型传来的 arguments 是 JSON 字符串，解析成对象；解析失败兜底空对象
      let args;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const argPreview = JSON.stringify(args).slice(0, 200); // 日志截断防爆
      // run_command 单独用 [run] 标记，其他用 [tool]
      if (name === "run_command") {
        console.log(`\n[run] ${args.command || ""}`);
      } else {
        console.log(`\n[tool] ${name}(${argPreview})`);
      }
      const result = await callTool(name, args, ctx);
      const preview = result.slice(0, 300);
      // run_command 已经流式打印过输出了，不重复打印全文；其他工具打印结果摘要
      if (name !== "run_command") {
        console.log(`[result] ${preview}${result.length > 300 ? ` ... (+${result.length - 300} chars)` : ""}`);
      } else if (result.length > 300) {
        console.log(`[result] (truncated, ${result.length} chars total)`);
      }
      // 返回标准 tool 消息格式：tool_call_id 关联到对应的调用，content 是结果
      return {
        role: "tool",
        tool_call_id: call.id,
        name,
        content: result,
      };
    });

    // 等所有工具执行完，结果消息全部入历史，下一轮模型就能看到工具结果
    const toolMessages = await Promise.all(pending);
    for (const tm of toolMessages) history.push(tm);
    // 继续 for 循环，让模型基于工具结果再思考
  }

  // 达到 MAX_STEPS 仍未结束，强制停止避免无限循环
  console.log("\n[agent] 达到最大步数，停止。");
}
