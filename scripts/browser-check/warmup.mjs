// **应用预热点**（`run-all` 在跑套件之前调用一次）：
// 冷启动的 Vite 要转译整棵模块图、应用要挂载编辑器并把打包字体装进 webview —— 实测首屏
// `responseEnd` 7.9s（机器忙时更久）。这笔开销以前是**第一个套件的第一次 boot** 付的，于是
// `Page.navigate` 的 CDP 调用超时、或 `waitFor(.cm-content)` 超时重试，报出来却像环境玄学。
//
// 这里加载一遍就够（2026-09-26 提速）：**一遍同时预热了两处缓存** —— dev server 侧的模块转译
// 结果与浏览器侧的模块缓存都在这一次加载里建好，而且这次加载本身就走完整的"挂载 + 装字体"
// 路径。以前加载两遍，第二遍实测 5.4s 是纯重复（两处缓存都不会因为再加载一遍而更快）；
// "第二遍要和各套件 boot 同级"这个诊断价值由下面打印的两段耗时代替。
import { connect } from "./cdp.mjs";

const url =
  process.env.BROWSER_CHECK_URL ??
  `http://127.0.0.1:${process.env.BROWSER_CHECK_PORT ?? "1425"}/?browserdev=1`;
const loads = Number(process.env.WARMUP_LOADS ?? "1");

const c = await connect();
try {
  for (let i = 1; i <= loads; i++) {
    const t0 = Date.now();
    await c.goto(url);
    console.log(`第 ${i} 次加载：${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} finally {
  await c.close();
}
