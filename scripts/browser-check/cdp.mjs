// 极简 CDP 驱动（零依赖；Node 24 自带全局 WebSocket）。
//
// 用途：在无显示器的环境下验证本仓库的「浏览器开发模式」页面
// （`npm run dev -- --host 0.0.0.0` + `http://localhost:1420/?browserdev=1`，见
// src/lib/dev/browser-dev-stub.ts），由 headless Chrome 驱动真实输入与选区，并对 DOM 断言、
// 截图取证。
//
// 运行环境：WSL 里通过 Windows 的 chrome.exe（WSL 互通）启动 headless Chrome，
// CDP 端口可经 localhost 直连（镜像网络模式）。
//
// 启动被控浏览器：
//   "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
//     --disable-gpu --no-first-run --user-data-dir='C:\\...\\cdp-profile' \
//     --remote-debugging-port=9333 --remote-debugging-address=0.0.0.0 \
//     --window-size=1400,900 'http://localhost:1420/?browserdev=1'
//
// 截图写到 Windows 临时目录（WSL 可直接读 /mnt/c/...）。
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9333";

/**
 * 被验收页面的地址（浏览器开发模式）。默认 1420 —— **但 1420 也是 `npm run tauri dev`
 * 的 Vite 端口**：用户自己开着桌面应用时，验收脚本要用别的端口跑，例如
 *   BROWSER_CHECK_PORT=1425 npm run dev -- --port 1425   # 起服务
 *   BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg.mjs
 * （默认 1420 只为保持既有文档/命令不变，两者不要同时占同一个端口。）
 */
export const DEV_URL =
  process.env.BROWSER_CHECK_URL ??
  `http://localhost:${process.env.BROWSER_CHECK_PORT ?? "1420"}/?browserdev=1`;

/** 取第一个 page 目标的 ws 地址 */
async function pageTarget() {
  const res = await fetch(`http://localhost:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("CDP: 未找到 page 目标");
  return page.webSocketDebuggerUrl;
}

export async function connect() {
  const ws = new WebSocket(await pageTarget());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  // 每次 CDP 调用都有超时：Chrome 崩了 / WebSocket 断了时，`pending` 里的 Promise 永远不会
  // settle，调用方（尤其 `waitFor` 的轮询）会**死等**——表现是整个套件挂住而不是报错。
  // 2026-09-24 编辑回放段实测卡死过一次，所以这里兜住。
  const CALL_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS ?? 30000);
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      const timer = setTimeout(() => {
        pending.delete(mid);
        rej(new Error(`CDP 调用超时（${CALL_TIMEOUT_MS}ms）：${method}`));
      }, CALL_TIMEOUT_MS);
      pending.set(mid, {
        res: (v) => {
          clearTimeout(timer);
          res(v);
        },
        rej: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "evaluate 失败: " +
          (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)),
      );
    }
    return r.result.value;
  };

  return {
    send,
    evaluate,
    events,
    close: () => ws.close(),

    /**
     * 导航到目标地址并**等应用挂载出来**（`.cm-content` 出现为止）。两处讲究：
     *
     * 1. 先跳 about:blank 再跳目标：同 URL 的 Page.navigate 不会重新加载，若上一次加载停在了
     *    错误页（如 dev server 正在改写文件时的 500），会一直复现旧页面；
     * 2. **最多重试 3 次**：验收脚本会反复换 URL / 反复重载（每次换 `&blockslow=1` 这类参数都算
     *    一次导航），实测偶发被上一次导航打断、页面停在 about:blank —— 那一轮就白跑了。
     *    只等"URL 对了"不够，必须等到页面真的挂载出来。
     */
    async goto(url) {
      await send("Page.enable");
      for (let attempt = 1; ; attempt++) {
        await send("Page.navigate", { url: "about:blank" });
        await new Promise((r) => setTimeout(r, 200));
        await send("Page.navigate", { url });
        try {
          await this.waitFor(`location.href.startsWith(${JSON.stringify(url.split("?")[0])})`, {
            timeout: 15000,
          });
          await this.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 15000 });
          return;
        } catch (e) {
          if (attempt >= 3) throw e;
        }
      }
    },

    /** 轮询直到表达式为真；超时抛错（失败信息里带表达式，便于定位） */
    async waitFor(expr, { timeout = 20000, interval = 150 } = {}) {
      const t0 = Date.now();
      for (;;) {
        let v = false;
        try {
          v = await evaluate(expr);
        } catch {
          v = false;
        }
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${expr}`);
        await new Promise((r) => setTimeout(r, interval));
      }
    },

    async screenshot(path) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(r.data, "base64"));
      return path;
    },

    /** 视口坐标点击（左键单击） */
    async click(x, y) {
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
        buttons: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
        buttons: 0,
      });
    },

    /**
     * 从 (x1,y1) 拖到 (x2,y2)（真实鼠标事件路径：mousePressed → 若干 mouseMoved → mouseReleased）。
     * 中间那几步不能省：CodeMirror 的 MouseSelection 要看到"按着键移动了 10px 以上"才开始拖选。
     */
    async drag(x1, y1, x2, y2, { steps = 6 } = {}) {
      const base = { button: "left", buttons: 1, clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, ...base });
      for (let i = 1; i <= steps; i++) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: x1 + ((x2 - x1) * i) / steps,
          y: y1 + ((y2 - y1) * i) / steps,
          ...base,
        });
      }
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x2,
        y: y2,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    },

    /** Ctrl+A 全选（用于整篇替换） */
    async selectAll() {
      const base = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },

    /** 在焦点处输入文本（走真实输入路径，CM6 可正常处理） */
    async type(text) {
      await send("Input.insertText", { text });
    },

    /**
     * 发送单个按键（key 形如 "ArrowLeft"/"End"/"Backspace"）。
     * modifiers 为 CDP 位掩码：1=Alt 2=Ctrl 4=Meta 8=Shift（如 Ctrl+B → modifiers: 2）。
     */
    async key(key, { code, keyCode = 0, modifiers = 0 } = {}) {
      const base = { key, code: code ?? key, windowsVirtualKeyCode: keyCode, modifiers };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },

    /**
     * 在视口坐标处滚一次滚轮（真实鼠标滚轮事件路径）。
     * deltaY 负数 = 向上滚；modifiers 同上（Ctrl+Shift = 2 | 8 = 10）。
     * 注意：Ctrl+滚轮在 WebView 里是页面缩放，所以带修饰键的用例必须验证页面缩放没被触发
     * （见 wysiwyg.mjs 第 24 组的分栏比例断言）。
     */
    async wheel(x, y, deltaY, { modifiers = 0, deltaX = 0 } = {}) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        modifiers,
      });
    },
  };
}
