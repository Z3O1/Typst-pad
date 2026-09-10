// 浏览器开发模式的诊断小工具：导航到页面，等待/报告实际渲染结果与页面内错误。
// 用法：node scripts/browser-check/probe.mjs [url]
import { connect } from "./cdp.mjs";

const url = process.argv[2] ?? "http://localhost:1420/?browserdev=1";
const c = await connect();

// 先把错误收集器挂进页面（导航前注册 Runtime 事件）
await c.send("Runtime.enable");
await c.send("Log.enable");
const errors = [];
c.events.push = (...args) => Array.prototype.push.apply(c.events, args);

await c.goto(url);
await new Promise((r) => setTimeout(r, 3000));

const info = await c.evaluate(`({
  url: location.href,
  title: document.title,
  bodyText: document.body.innerText.slice(0, 400),
  htmlLen: document.body.innerHTML.length,
  hasEditor: !!document.querySelector(".cm-content"),
  hasMenuBar: !!document.querySelector(".toolbar"),
  viteOverlay: !!document.querySelector("vite-error-overlay"),
})`);
console.log(JSON.stringify(info, null, 1));

const pageErrors = await c.evaluate(`window.__probeErrors ?? null`);
if (pageErrors) console.log("页面内错误:", JSON.stringify(pageErrors));
c.close();
