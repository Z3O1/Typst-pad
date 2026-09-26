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
  // 默认 60s：编辑回放要注入 9 份状态夹具（每份 135 块的 JSON），导航 + 首帧解析会明显变慢
  const CALL_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS ?? 60000);
  // 导航的 CDP 回应偶尔要等满 60s，但页面实际已经就绪；goto 随后会独立检查 URL / 挂载 / 恢复。
  const NAV_TIMEOUT_MS = Math.min(CALL_TIMEOUT_MS, Number(process.env.CDP_NAV_TIMEOUT_MS ?? 15000));
  const send = (method, params = {}, timeoutMs = CALL_TIMEOUT_MS) =>
    new Promise((res, rej) => {
      const mid = ++id;
      const timer = setTimeout(() => {
        pending.delete(mid);
        rej(new Error(`CDP 调用超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
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
     * 导航到目标地址并**等应用挂载出来**（`.cm-content` 出现为止）。
     *
     * **一次导航就够**（2026-09-26 提速）：以前无论如何都先跳 `about:blank` 再跳目标 —— 两跳的
     * 代价在长套件里是实打实的（`wysiwyg.mjs` 有 37 次 `goto`、`writing-stability` 有 6 次 boot
     * 各含 2 次），而两跳只为绕开"同 URL 的 `Page.navigate` 不会重新加载"这一条：
     *   * 目标与当前地址**相同** → 用 `Page.reload`（本身就是一次真正的重新加载）；
     *   * 不同 → 直接 `Page.navigate`（换地址本来就会重新加载，中间那跳是多余的）。
     * 第 2 次重试起退回原来的两跳写法（`about:blank` 中转能救"停在错误页"的那种状态），
     * 所以最坏情况与改之前完全一致，只是常规路径少了一半导航。
     *
     * `Page.navigate` 自己报超时不算失败（2026-09-25 实测的假故障）：冷启动时 Vite 要转译整棵
     * 模块图，页面 `responseEnd` 实测 7.9s，机器更慢时整条导航的**回应**会超过 CDP 调用超时 ——
     * 但页面其实已经跳过去了、应用也起来了。所以导航调用一律 try/catch 吞掉，成败只看 waitFor。
     */
    async goto(url) {
      await send("Page.enable");
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        // 导航回应超时后，旧页面可能还停在同一 URL。记录文档的启动时刻，
        // 只有新文档加载出来才算成功，避免把旧页面的挂载标记误当作本轮结果。
        const previous = await evaluate(
          "({ href: location.href, origin: performance.timeOrigin })",
        ).catch(() => null);
        try {
          if (attempt === 1) {
            if (previous?.href === url)
              await send("Page.reload", { ignoreCache: false }, NAV_TIMEOUT_MS);
            else await send("Page.navigate", { url }, NAV_TIMEOUT_MS);
          } else {
            await send("Page.navigate", { url: "about:blank" }, NAV_TIMEOUT_MS);
            await new Promise((r) => setTimeout(r, 200));
            await send("Page.navigate", { url }, NAV_TIMEOUT_MS);
          }
        } catch (e) {
          lastError = e;
        }
        try {
          await this.waitFor(
            `location.href === ${JSON.stringify(new URL(url).href)} && performance.timeOrigin !== ${JSON.stringify(previous?.origin ?? null)}`,
            { timeout: 30000 },
          );
          await this.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
          /**
           * **再等"存档已经落到页面上"**（`?browserdev=1` 才有的只读标记，见
           * `src/lib/dev/write-test-hook.ts`）：子组件（编辑器）的 `onMount` 比父页面的先跑完，
           * 所以 `.cm-content` 出现时主题/设置/恢复的内容**可能还没应用**。不等这个标记就有两类
           * 假红：断言量到默认主题（`writing-blocks` 第 6 组的暗色切片）、以及应用随后那次
           * 300ms 防抖写盘把"还没恢复完"的默认值写回存档、盖掉测试种进去的设置
           * （`wysiwyg` 的"关掉启动自动检查更新"）。
           *
           * 非浏览器开发模式的页面没有这个标记（桌面版也不会挂它）—— 那时这一步会超时并把整条
           * `goto` 判失败（**fail-closed**：本仓库所有套件都跑在 `?browserdev=1` 上，标记不见就是
           * 钩子坏了或恢复没跑完，宁可响亮地红，也不要让断言在"设置还没生效"的状态上跑）。
           */
          await this.waitFor(`window.__typstPadRestored === true`, { timeout: 15000 });
          return;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError ?? new Error("goto 失败：应用没有挂载出来");
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
