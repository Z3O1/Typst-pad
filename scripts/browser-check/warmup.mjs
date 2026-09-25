// **应用预热点**（`run-all` 在跑套件之前调用一次）：
// 冷启动的 Vite 要转译整棵模块图、应用要挂载编辑器并把打包字体装进 webview —— 实测首屏
// `responseEnd` 7.9s（机器忙时更久）。这笔开销以前是**第一个套件的第一次 boot** 付的，于是
// `Page.navigate` 的 CDP 调用超时、或 `waitFor(.cm-content)` 超时重试，报出来却像环境玄学。
//
// 这里先加载两遍（第二遍走浏览器模块缓存，与各套件 boot 的开销同级）：各套件的 boot 就都是热的；
// 应用根本起不来时也在这里**早失败**，而不是等某个套件跑到一半才炸。
import { connect } from "./cdp.mjs";

const url =
  process.env.BROWSER_CHECK_URL ??
  `http://127.0.0.1:${process.env.BROWSER_CHECK_PORT ?? "1425"}/?browserdev=1`;

const c = await connect();
try {
  let t0 = Date.now();
  await c.goto(url);
  console.log(`首次加载（冷）：${((Date.now() - t0) / 1000).toFixed(1)}s`);
  t0 = Date.now();
  await c.goto(url);
  console.log(`再次加载（热，与各套件 boot 同级）：${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await c.close();
}
