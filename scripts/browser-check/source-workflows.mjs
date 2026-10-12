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
const { check: record, state } = createChecker();
const c = await connect();
const originalAgent = await c.evaluate(
  "({userAgent:navigator.userAgent,platform:navigator.platform})",
);
const check = record;
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

const replaceMath = async (text, anchor = text.length) => {
  await c.evaluate(`(() => {
    const view = window.__typstPadView;
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:${JSON.stringify(text)}},selection:{anchor:${anchor}}});
    view.focus();return true;
  })()`);
};
let sourcePrefixes = true;
for (const prefix of ["  \\ =& ", "\t\\\t&=\t"]) {
  const text = `$\n a\n${prefix}b\n$`,
    pos = text.indexOf("b") + 1;
  await replaceMath(text, pos);
  await c.key("Enter", { keyCode: 13 });
  sourcePrefixes &&=
    (await doc()) === text.slice(0, pos) + "\n" + prefix + text.slice(pos) &&
    (await c.evaluate("window.__typstPadView.state.selection.main.head")) ===
      pos + 1 + prefix.length;
}
check("源码模式多行数学 Enter 原样延续换行/对齐前缀", sourcePrefixes);
await replaceMath("$\n  a\n$", 5);
await c.key("Enter", { keyCode: 13 });
check("无前缀公式保留既有单换行和缩进", (await doc()) === "$\n  a\n  \n$");
await replaceMath("$x$");
await c.key("Enter", { keyCode: 13 });
check("源码模式闭合 $ 后仍只插入一个源码换行", (await doc()) === "$x$\n");

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
try {
  for (const inputPath of ["EditContext", "DOM"]) {
    const check = (label, ...args) => record(`${inputPath}: ${label}`, ...args);
    await c.send(
      "Emulation.setUserAgentOverride",
      inputPath === "EditContext"
        ? {
            userAgent: originalAgent.userAgent.replace(/\([^)]*\)/, "(Linux; Android 14)"),
            platform: "Linux armv8l",
          }
        : originalAgent,
    );
    await boot(c, DEV_URL);
    await c.waitFor(
      inputPath === "EditContext"
        ? "!!window.__typstPadView.contentDOM.editContext"
        : "!window.__typstPadView.contentDOM.editContext",
    );
    const inputSnapshot = () =>
      c.evaluate(
        "(() => { const v=window.__typstPadView, ec=v.contentDOM.editContext; return {doc:v.state.doc.toString(),head:v.state.selection.main.head,context:ec?{text:ec.text,start:ec.selectionStart,end:ec.selectionEnd}:null}; })()",
      );
    const checkInput = async (label, expected, head = 0) => {
      const snapshot = await inputSnapshot();
      console.log(`SESSIONINPUT ${inputPath} ${label} ${JSON.stringify(snapshot)}`);
      check(
        label,
        snapshot.doc === expected &&
          snapshot.head === head &&
          (inputPath === "DOM"
            ? snapshot.context === null
            : snapshot.context?.text === expected &&
              snapshot.context.start === head &&
              snapshot.context.end === head),
        JSON.stringify(snapshot),
      );
    };
    const nextInput = async (label, expected) => {
      await c.evaluate("window.__typstPadView.focus(); true");
      await c.send("Input.dispatchKeyEvent", { type: "char", text: "Z", key: "Z" });
      await checkInput(label, `Z${expected}`, 1);
      await c.key("z", { keyCode: 90, modifiers: 2 });
      await sleep(80);
    };
    // 新文档身份，而不是字符串变化，决定撤销边界；使用实际 Editor 生命周期与文件接线。
    await flushStateSeed(c, {
      content: "Session A",
      filePath: null,
      fileTitle: "未命名.typ",
      dirty: false,
      viewMode: "source",
      restoreSession: true,
      editorWrap: true,
      theme: "light",
      tabSpaces: 4,
    });
    await c.goto(DEV_URL);
    await c.waitFor(compileSettled("Session A"));
    await c.evaluate(
      "window.__sessionView = window.__typstPadView; window.__typstPadView.focus(); true",
    );
    await checkInput("恢复会话同步输入上下文与选区", "Session A");
    await nextInput("恢复后下一次真实输入使用恢复正文", "Session A");
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check("恢复会话不能撤销到启动正文", (await doc()) === "Session A");
    const replaceSource = async (value) => {
      await c.evaluate(
        `window.__typstPadView.dispatch({changes:{from:0,to:window.__typstPadView.state.doc.length,insert:${JSON.stringify(value)}}}); window.__typstPadView.focus(); true`,
      );
      await c.waitFor(compileSettled(value));
    };
    // 在当前会话保存 B 的副本，再编辑 A，随后通过真正的打开命令进入 B。
    await replaceSource("Session B");
    await c.evaluate("window.__browserDevSavePath='/fake/b.typ'");
    await c.key("s", { keyCode: 83, modifiers: 2 });
    await c.waitFor("!window.__browserDevLastTitle.includes(' •')");
    await replaceSource("Session A");
    await c.evaluate(
      "window.__typstPadView.dispatch({selection:{anchor:9}}); window.__typstPadView.focus(); true",
    );
    console.log(
      `SESSIONINPUT ${inputPath} before equal-length open ${JSON.stringify(await inputSnapshot())}`,
    );
    await sleep(550); // 超过 CodeMirror 默认撤销分组间隔
    await c.evaluate("window.__browserDevConfirm=true; window.__browserDevOpenPath='/fake/b.typ'");
    await c.key("o", { keyCode: 79, modifiers: 2 });
    await c.waitFor(compileSettled("Session B"));
    await checkInput("等长 A→B 打开同步正文与起始选区", "Session B");
    await nextInput("打开后下一次真实输入从 B 起点插入", "Session B");
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check(
      "打开 B 后撤销不能恢复 A，B 的保存基线不变",
      (await doc()) === "Session B" &&
        (await c.evaluate("!window.__browserDevLastTitle.includes(' •')")),
    );
    await c.key("s", { keyCode: 83, modifiers: 2 });
    await sleep(100);
    check(
      "打开后撤销再保存只写入 B 原文和 B 路径",
      await c.evaluate(
        "window.__browserDevWrites.at(-1).content === 'Session B' && window.__browserDevWrites.at(-1).path === '/fake/b.typ'",
      ),
    );
    await replaceSource("Session B edit");
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check("B 内编辑仍可正常撤销到 B", (await doc()) === "Session B");
    // 设置与 compartment 重配仍属于当前文档，不应清除历史。
    await replaceSource("Settings edit");
    await c.key(",", { keyCode: 188, modifiers: 2 });
    await c.waitFor("!!document.querySelector('.settings-tab-input')");
    await c.evaluate(
      "const input=document.querySelector('.settings-tab-input'); input.value='6'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.settings-modal .primary').click(); true",
    );
    await c.waitFor("!document.querySelector('.settings-modal')");
    await c.evaluate("window.__typstPadView.focus(); true");
    await c.key("z", { keyCode: 90, modifiers: 1 }); // Alt+Z 重配换行 compartment
    await c.waitFor("!window.__typstPadView.contentDOM.classList.contains('cm-lineWrapping')");
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check("保存偏好与换行重配保留当前撤销历史", (await doc()) === "Session B");
    // 相同文本的新会话也清空历史：编辑 → 保存 → 打开同路径，正文字符串不变。
    await replaceSource("Equal session");
    await c.key("s", { keyCode: 83, modifiers: 2 });
    await c.waitFor("!window.__browserDevLastTitle.includes(' •')");
    await c.evaluate(
      "window.__typstPadView.dispatch({selection:{anchor:window.__typstPadView.state.doc.length}}); true",
    );
    await c.key("o", { keyCode: 79, modifiers: 2 });
    await sleep(150);
    await checkInput("相同正文重新打开同步起始选区", "Equal session");
    await nextInput("相同正文重新打开后真实输入使用新选区", "Equal session");
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check("相同正文的重新打开也隔离撤销历史", (await doc()) === "Equal session");
    await replaceSource("Before new");
    await c.key("n", { keyCode: 78, modifiers: 2 });
    await c.waitFor("window.__typstPadView.state.doc.length === 0");
    await checkInput("新建清空输入上下文与选区", "");
    await nextInput("新建后下一次真实输入使用空正文", "");
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check("新建后撤销不能恢复前文档", (await doc()) === "");
    await replaceSource("New edit");
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check("新文档内编辑仍可撤销到空正文", (await doc()) === "");
    check(
      "新会话保留同一 EditorView 与当前主题、换行配置",
      await c.evaluate(
        "window.__sessionView === window.__typstPadView && !window.__typstPadView.dom.classList.contains('cm-dark') && !window.__typstPadView.contentDOM.classList.contains('cm-lineWrapping')",
      ),
    );
    await c.evaluate("window.__typstPadView.focus(); true");
    await c.key("Tab", { code: "Tab", keyCode: 9 });
    check("新会话保留设置驱动的 Tab 键位", (await doc()) === "      ");
    await replaceSource("History retained");
    await c.evaluate("window.__browserDevSavePath='/fake/new.typ'");
    await c.key("s", { keyCode: 83, modifiers: 2 });
    await c.waitFor("!window.__browserDevLastTitle.includes(' •')");
    await c.key("e", { keyCode: 69, modifiers: 2 });
    await c.key("e", { keyCode: 69, modifiers: 2 });
    await sleep(120);
    await c.key("z", { keyCode: 90, modifiers: 2 });
    await sleep(80);
    check(
      "首次保存改变路径与模式往返不清空当前历史",
      (await doc()) !== "History retained" &&
        (await c.evaluate("window.__sessionView === window.__typstPadView")),
    );
  }
} finally {
  await c.send("Emulation.setUserAgentOverride", originalAgent);
  await c.close();
}
finish(`通过 ${state.passed} 项检查；源码与文件流程（DOM/EditContext）`);
