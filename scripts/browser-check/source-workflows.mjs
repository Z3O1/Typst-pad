// 整页模式复用源码编辑器和文件流程：取消不写盘、显式保存、打开同步镜像与会话恢复。
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  createChecker,
  finish,
  sleep,
  flushStateSeed,
  compileSettled,
  COMPILE_IDLE,
} from "./harness.mjs";
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL);
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const text = "保存正文含中文🙂\n\n$x + y$";
// 从文档模式进源码模式：右上角「源码模式」按钮已随"文档模式只有文档"删除，只剩键盘 Ctrl+E
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.type(text);
await c.waitFor(compileSettled(text));
check("输入和整页编译不隐式写盘", await c.evaluate("!window.__browserDevWrites?.length"));
await c.key("s", { keyCode: 83, modifiers: 2 });
await sleep(100);
check(
  "取消保存保留源文档和未保存状态",
  (await doc()) === text &&
    (await c.evaluate(
      "!window.__browserDevWrites?.length && window.__browserDevLastTitle.includes(' •')",
    )),
);
await c.evaluate("window.__browserDevSavePath='/fake/saved.typ'");
await c.key("s", { keyCode: 83, modifiers: 2 });
await c.waitFor(
  `window.__browserDevLastCompile?.documentPath === '/fake/saved.typ' && ${COMPILE_IDLE}`,
);
// 路径改变也使自然纸型上下文失效：等无注入学习后的250ms重排，再固定PDF前的页面基准。
await sleep(350);
await c.waitFor(COMPILE_IDLE);
check(
  "保存写入当前源码并更新排版路径",
  await c.evaluate(
    `window.__browserDevWrites.length === 1 && window.__browserDevWrites[0].content === ${JSON.stringify(text)} && window.__browserDevWrites[0].path === '/fake/saved.typ'`,
  ),
);
check(
  "保存后排版输入回到当前状态",
  await c.evaluate(`${COMPILE_IDLE} && !window.__browserDevLastTitle.includes(' •')`),
);
const savedCount = await c.evaluate("window.__browserDevCallCounts.compile_doc");
await c.key("s", { keyCode: 83, modifiers: 2 });
await sleep(220);
check(
  "同路径保存不重新排版",
  (await c.evaluate("window.__browserDevCallCounts.compile_doc")) === savedCount,
);
const savedPages = await c.evaluate(
  "[...document.querySelectorAll('#preview-host>.document-page')].map(host=>host.shadowRoot.innerHTML).join('')",
);
await c.key("p", { keyCode: 80, modifiers: 2 });
await c.waitFor("window.__browserDevCallCounts.export_pdf === 1");
await sleep(50);
check(
  "PDF 导出失败仍保留完整页面",
  (await c.evaluate(
    "[...document.querySelectorAll('#preview-host>.document-page')].map(host=>host.shadowRoot.innerHTML).join('')",
  )) === savedPages && (await c.evaluate("!document.querySelector('#preview-host').hidden")),
);
await c.selectAll();
await c.type("修改后仍保留");
await sleep(220);
await c.key("n", { keyCode: 78, modifiers: 2 });
await sleep(100);
check("取消新建保留源码编辑镜像", (await doc()) === "修改后仍保留");
await c.evaluate("window.__browserDevConfirm=true;window.__browserDevOpenPath='/fake/saved.typ'");
await c.key("o", { keyCode: 79, modifiers: 2 });
await c.waitFor(
  `window.__typstPadView.state.doc.toString() === ${JSON.stringify(text)} && ${COMPILE_IDLE}`,
);
await c.key("e", { keyCode: 69, modifiers: 2 });
check(
  "打开文件并往返模式同步源文档",
  (await doc()) === text &&
    (await c.evaluate("getComputedStyle(document.querySelector('.editor-pane')).opacity === '0'")),
);
check("打开与模式切换没有额外写盘", await c.evaluate("window.__browserDevWrites.length === 2"));
await flushStateSeed(c, {
  content: text,
  filePath: "/fake/saved.typ",
  fileTitle: "saved.typ",
  dirty: true,
  viewMode: "write",
  restoreSession: true,
  chineseFont: "Noto Serif SC",
  autoCheckUpdates: false,
});
await c.goto(DEV_URL);
await c.waitFor(compileSettled(text));
check(
  "恢复会话用完整源码编译并保持未保存状态",
  (await doc()) === text &&
    (await c.evaluate(
      "window.__browserDevLastTitle.includes(' •') && getComputedStyle(document.querySelector('.editor-pane')).opacity === '0'",
    )),
);
check(
  "首次编译已含恢复字体与默认回退",
  await c.evaluate(
    "window.__browserDevLastCompile.fontFamilies.length > 1 && window.__browserDevLastCompile.fontFamilies.includes('Noto Serif SC')",
  ),
);
check("恢复不隐式写盘", await c.evaluate("!window.__browserDevWrites?.length"));

// Tab 档宽设置：存档 → 恢复 → Editor prop → 键位 getter 的完整链路。
// 上面的种子没写 tabSpaces ⇒ 恢复出默认 2；先切到源码模式（编辑器可见可聚焦）再按 Tab。
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.evaluate(
  "window.__typstPadView.dispatch({selection:{anchor:0}}); window.__typstPadView.focus(); true",
);
await c.key("Tab", { code: "Tab", keyCode: 9 });
check("存档缺 tabSpaces 时 Tab 插默认一档（2 空格）", (await doc()).startsWith("  "));

// tabSpaces=0（制表符，旧行为）：种进存档 → 重载恢复 → 同样位置按 Tab 应得 \t
await flushStateSeed(c, {
  content: text,
  filePath: "/fake/saved.typ",
  fileTitle: "saved.typ",
  dirty: true,
  viewMode: "source",
  restoreSession: true,
  tabSpaces: 0,
});
await c.goto(DEV_URL);
await c.waitFor(compileSettled(text));
await c.evaluate(
  "window.__typstPadView.dispatch({selection:{anchor:0}}); window.__typstPadView.focus(); true",
);
await c.key("Tab", { code: "Tab", keyCode: 9 });
check("tabSpaces=0 恢复后 Tab 插一个制表符", (await doc()).startsWith("\t"));

// 空脚手架 `$  $` 的 Enter 展开：中行一档与 tabSpaces 联动（本存档 = 0 → 制表符）
await c.evaluate(
  `window.__typstPadView.dispatch({changes:{from:0,to:window.__typstPadView.state.doc.length,insert:"$  $"},selection:{anchor:2}}); window.__typstPadView.focus(); true`,
);
await c.key("Enter", { code: "Enter", keyCode: 13 });
check("空脚手架中间 Enter 展开为三行（中行 = 制表符）", (await doc()) === "$\n\t\n$");
await c.evaluate(
  `window.__typstPadView.dispatch({selection:{anchor:0}}); window.__typstPadView.focus(); true`,
);
await c.key("Enter", { code: "Enter", keyCode: 13 });
check("光标不在脚手架中间 → 不接管（行首回车仍是普通换行）", (await doc()).startsWith("\n$\n"));

// 点击错误条目后输入：jumpTo 的 $effect 必须按 seq 幂等（回归：曾因对象 prop 每次重渲染
// 都被判"已变化"，输入一个字符就把光标反复拉回错误行）。
// DIAG-ERROR-MARKER 是桩内建的主源造错标记（行 1 列 1，无需页面夹具）。
await c.selectAll();
await c.type("DIAG-ERROR-MARKER");
const ERR_READY =
  "!!document.querySelector('.error-badge') && (document.querySelectorAll('.error-count')[0]?.textContent ?? '0') !== '0'";
await c.waitFor(ERR_READY, { timeout: 8000 });
await sleep(300);
await c.evaluate("document.querySelector('.error-badge').click()");
await c.waitFor("!!document.querySelector('.error-item')", { timeout: 5000 });
await c.evaluate("document.querySelector('.error-item').click()");
await sleep(350); // 等 jump effect 落地
const afterJump = await c.evaluate("window.__typstPadView.state.selection.main.head");
check("点击错误条目跳到诊断位置（行1列1）", afterJump === 0, `head=${afterJump}`);
await c.type("Z");
await sleep(650); // 等编译落地（验证光标没有被拉回）
const afterType = await c.evaluate("window.__typstPadView.state.selection.main.head");
check(
  "点击错误后输入一个字符，光标跟随输入前进（不被拉回错误行）",
  afterType === afterJump + 1,
  `head=${afterJump} → ${afterType}`,
);
await c.close();
finish(`通过 ${state.passed} 项检查；源码与文件流程`);
