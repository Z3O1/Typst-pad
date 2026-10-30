// 写作模式列表结构化退格：真实按键走 CodeMirror 键位，源码仍是唯一真相。
// 覆盖空项 / 体首 / 行首 / 嵌套反缩进、正文内普通删字、代码块与源码模式不接管、撤销一步。
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep } from "./harness.mjs";
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL);
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const head = () => c.evaluate("window.__typstPadView.state.selection.main.head");
const inDocumentMode = () => c.evaluate("!!document.querySelector('.document-pane')");
const compiles = () => c.evaluate("window.__browserDevCallCounts?.compile_doc ?? 0");

check("启动即文档模式（写作按键在这层生效）", await inDocumentMode());

// 夹具替换与真实按键分开分组：先落到指定源码与光标，再按真键（同 dollar-completion 的做法）。
const replace = async (text, anchor = text.length) => {
  await c.evaluate(`(() => {
    const view = window.__typstPadView;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(text)} },
      selection: { anchor: ${anchor} },
      annotations: view.state.update({}).constructor.time.of(0),
    });
    view.focus();
    return true;
  })()`);
  await sleep(120);
};
const backspace = async () => {
  await c.key("Backspace", { keyCode: 8 });
  await sleep(120);
};

// ① 真实输入链路：输入列表项 → Enter 续项 → 退格删掉空项，留下一个空段落。
await replace("");
await c.type("- 甲");
await c.key("Enter", { keyCode: 13 });
await sleep(120);
check("输入列表项后 Enter 续出下一项空标记", (await doc()) === "- 甲\n- " && (await head()) === 6);
const before = await compiles();
await backspace();
check("空项退格整条抹掉，不留下孤立标记", (await doc()) === "- 甲\n" && (await head()) === 4);
await c.waitFor(`(window.__browserDevCallCounts?.compile_doc ?? 0) > ${before}`);
check(
  "重新排版的是退格后的原文（空段落占位只进展示投影）",
  (
    await c.evaluate("(window.__browserDevLastCompile?.src ?? '').replace(/\\u00a0/g, '')")
  ).startsWith("- 甲\n"),
);

// ② 体首退格：去掉标记，正文退成普通段落。
await replace("- 甲乙", 2);
await backspace();
check("光标在正文之前退格只去掉标记", (await doc()) === "甲乙" && (await head()) === 0);

// ③ 行首退格：并进上一行。
await replace("甲\n- 乙", 2);
await backspace();
check("光标在标记之前退格并入上一行", (await doc()) === "甲乙" && (await head()) === 1);

// ④ 嵌套项退格：先反缩进一档（默认 tabSpaces = 2，与 Tab 对称）。
await replace("  - 甲", 4);
await backspace();
check("嵌套项退格先反缩进一档", (await doc()) === "- 甲" && (await head()) === 2);

// ⑤ 正文里退格仍是普通删字，不动结构。
await replace("- 甲乙", 4);
await backspace();
check("正文内退格只删一个字符", (await doc()) === "- 甲");

// ⑥ 显式编号列表按同样口径处理。
await replace("3. 甲", 3);
await backspace();
check("显式编号列表项退格同样去掉标记", (await doc()) === "甲");

// ⑦ 代码块里的同形文本不是列表项：只删一个字符。
await replace("```typ\n- 甲\n```", 9);
await backspace();
check("代码块内的同形标记不按列表处理", (await doc()) === "```typ\n-甲\n```");

// ⑧ 结构化退格作为一次编辑可撤销。
await replace("- 甲\n- ", 6);
await backspace();
const deleted = await doc();
await c.key("z", { keyCode: 90, modifiers: 2 });
await sleep(120);
check(
  "结构化退格一次撤销完整恢复源码与空项",
  deleted === "- 甲\n" && (await doc()) === "- 甲\n- " && (await head()) === 6,
);

// ⑨ 源码模式不接管：保留默认的删字 / 并行。
await replace("甲\n- 乙", 2);
await c.key("e", { keyCode: 69, modifiers: 2 });
await sleep(200);
const sourceMode = !(await inDocumentMode());
await backspace();
const sourceDoc = await doc();
await c.key("e", { keyCode: 69, modifiers: 2 });
await sleep(200);
check(
  "源码模式保留默认退格语义（不重组列表结构）",
  sourceMode && sourceDoc === "甲- 乙" && (await inDocumentMode()),
);

finish(`通过 ${state.passed} 项检查；写作模式列表结构化退格`);
