// spinner.js — 思考等待旋转动画
//
// 用途：agent 调 LLM 时首个 token 到达前有一段等待，这段空窗期显示
//       旋转字符 + 已等待秒数，让用户知道在工作而不是卡死。
//       首个 token 一来就 stop()，让位给流式文本输出。
//
// 零依赖，用 setInterval 驱动，ANSI 光标控制擦除旧帧。

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// 创建一个旋转动画实例，返回 { stop }。
// label: 动画前缀文案，如 "思考中"
// 调用 stop() 停止并擦除动画行，之后 caller 可继续在同一行写文本。
export function startSpinner(label = "思考中") {
  let i = 0;
  const start = Date.now();
  let active = true;

  // \r 回到行首，\x1b[K 擦到行尾，再写新帧 + 已用秒数
  const render = () => {
    if (!active) return;
    const frame = FRAMES[i % FRAMES.length];
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r\x1b[K${frame} ${label} ${secs}s`);
    i++;
  };
  render(); // 立即显示第一帧，不等 interval
  const timer = setInterval(render, 100);

  return {
    // 停止动画，擦除当前行，光标回到行首，留给后续输出
    stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
      process.stdout.write(`\r\x1b[K`);
    },
  };
}
