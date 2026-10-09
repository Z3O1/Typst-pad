// $ 定界符：真实输入路径、选区、多光标、撤销及 DOM/EditContext 合成护栏。
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep } from "./harness.mjs";
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL);
await c.key("e", { keyCode: 69, modifiers: 2 });
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const head = () => c.evaluate("window.__typstPadView.state.selection.main.head");
const replace = async (text, anchor = text.length, end = anchor) => {
  await c.evaluate(`(() => {
    const view = window.__typstPadView;
    // 测试夹具替换与下一次真实按键分开分组，不改变真实输入的撤销策略。
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:${JSON.stringify(text)}},selection:{anchor:${anchor},head:${end}},annotations:view.state.update({}).constructor.time.of(0)});
    view.focus();
    return true;
  })()`);
};

await replace("前 ");
await c.type("$");
await c.type("x");
await c.type("$");
check("行内依次输入 $、x、$ 不增加多余定界符", (await doc()) === "前 $x$" && (await head()) === 5);

const continuousHistory = [];
for (const [open, close] of [
  ["(", ")"],
  ["$", "$"],
]) {
  await replace("");
  for (const text of [open, "x", close, "y"]) await c.type(text);
  await c.key("z", { keyCode: 90, modifiers: 2 });
  const undone = { doc: (await doc()).replace(/[()]/g, "$"), head: await head() };
  await c.key("y", { keyCode: 89, modifiers: 2 });
  continuousHistory.push({
    undone,
    redone: { doc: (await doc()).replace(/[()]/g, "$"), head: await head() },
  });
}
check(
  "跳过闭合符后继续键入正文，撤销/重做与原生括号同组",
  continuousHistory[1].undone.doc === "" &&
    continuousHistory[1].redone.doc === "$x$y" &&
    JSON.stringify(continuousHistory[0]) === JSON.stringify(continuousHistory[1]),
  JSON.stringify(continuousHistory),
);

await replace("");
await c.type("$");
check("空行像 ( 一样只补出 $$，光标在中间", (await doc()) === "$$" && (await head()) === 1);
await c.type(" ");
check("空配对中的空格显式进入行间公式", (await doc()) === "$  $" && (await head()) === 2);
await c.key("Backspace", { keyCode: 8 });
const compact = (await doc()) === "$$" && (await head()) === 1;
await c.type("$");
check(
  "退格撤回行间空格，随后 $ 跳过自动闭合符",
  compact && (await doc()) === "$$" && (await head()) === 2,
);

await replace("abc", 1);
await c.type("(");
const wordBracket = (await doc()).replace(/[()]/g, "$");
await replace("abc", 1);
await c.type("$");
check("词中像 ( 一样只插入一个字符，不强行配对", (await doc()) === wordBracket);

await replace("(x)", 2);
await c.type(")");
const manualBracket = { doc: (await doc()).replace(/[()]/g, "$"), head: await head() };
await replace("$x$", 2);
await c.type("$");
check(
  "手工闭合符像 ) 一样不自动跳过",
  (await doc()) === manualBracket.doc && (await head()) === manualBracket.head,
);

await replace("$x$", 0);
await c.type("$");
check(
  "右侧是公式起始符时插入新配对，不误跳过原公式",
  (await doc()) === "$$$x$" && (await head()) === 1,
);

await replace("$x + ");
await c.type("$");
check("未闭合公式只输入闭合符，不额外补一对", (await doc()) === "$x + $");

let protectedEnds = true;
for (const text of ["// 注释", "/* 注释", "/* /* */", "`raw", "```\nraw", '#let s = "abc']) {
  await replace(text);
  await c.type("$");
  protectedEnds &&= (await doc()) === `${text}$`;
}
check("注释、raw 和代码字符串的未闭合末端保持字面输入", protectedEnds);

await replace('"正 文"', 2);
await c.type("$");
check("正文直引号内部的空白前仍支持数学配对", (await doc()) === '"正$$ 文"');

await replace("\\\\");
await c.type("$");
check("偶数反斜杠不误判为转义", (await doc()) === "\\\\$$");

await replace("前 x+y 后", 6, 1);
await c.type("$");
check(
  "输入 $ 像 ( 一样原样包裹，保留完整反向选区",
  await c.evaluate(
    "window.__typstPadView.state.doc.toString()==='前$ x+y $后' && window.__typstPadView.state.selection.main.anchor===7 && window.__typstPadView.state.selection.main.head===2",
  ),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
const undone = (await doc()) === "前 x+y 后";
await c.key("y", { keyCode: 89, modifiers: 2 });
check("选区包裹可撤销/重做", undone && (await doc()) === "前$ x+y $后");

await replace("前 ");
await c.type("$");
await c.type("x");
await c.evaluate(`(() => {
  const view=window.__typstPadView;
  view.dispatch({changes:{from:view.state.doc.length,insert:'\\n// 注释\\n正文 '}});
  return true;
})()`);
await c.evaluate(`(() => {
  const view=window.__typstPadView, Selection=view.state.selection.constructor;
  view.dispatch({selection:Selection.create([Selection.cursor(4),Selection.cursor(11),Selection.cursor(view.state.doc.length)],2)});
  view.focus();return true;
})()`);
await c.type("$");
check(
  "多光标分别跳闭合符、输入字面符和配对，保留主光标",
  await c.evaluate(
    "window.__typstPadView.state.doc.toString()==='前 $x$\\n// 注释$\\n正文 $$' && window.__typstPadView.state.selection.ranges.length===3 && window.__typstPadView.state.selection.mainIndex===2",
  ),
);

await replace("$$ $$", 1);
await c.evaluate(`(() => {
  const view=window.__typstPadView, Selection=view.state.selection.constructor;
  view.dispatch({selection:Selection.create([Selection.cursor(1),Selection.cursor(4)],1)});
  view.focus();return true;
})()`);
await c.key("Backspace", { keyCode: 8 });
check(
  "多光标退格各删空配对，不丢选区",
  (await doc()) === " " &&
    (await c.evaluate("window.__typstPadView.state.selection.ranges.length")) === 2,
);

await replace("  ");
await c.type("$");
await c.key("Enter", { keyCode: 13 });
check(
  "缩进脚手架展开后正文和闭合符保留基准缩进",
  (await doc()) === "  $\n    \n  $" && (await head()) === 8,
);
await c.type("x");
await c.type("$");
check(
  "输入 $ 可跨末尾空白与换行跳出三行公式",
  (await doc()) === "  $\n    x\n  $" && (await head()) === 13,
);

await replace("  $\n    \n  $", 8);
await c.key("Backspace", { keyCode: 8 });
const collapsed = (await doc()) === "  $$" && (await head()) === 3;
await c.key("Backspace", { keyCode: 8 });
const removed = (await doc()) === "  ";
await c.key("z", { keyCode: 90, modifiers: 2 });
check(
  "空三行公式分两级退格，撤销恢复原光标",
  collapsed && removed && (await doc()) === "  $\n    \n  $" && (await head()) === 8,
);

await replace("");
await c.evaluate(`(() => {
  const data=new DataTransfer();data.setData('text/plain','$');
  window.__typstPadView.contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  return true;
})()`);
check("粘贴单个 $ 保持原文，不触发配对", (await doc()) === "$");

await replace("");
await c.evaluate(
  "window.__typstPadView.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));true",
);
await c.type("$");
await c.evaluate(
  "window.__typstPadView.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true",
);
await sleep(80);
check("DOM 合成中的 $ 不改写输入法内容", (await doc()) === "$");

await c.key("e", { keyCode: 69, modifiers: 2 });
await c.waitFor("getComputedStyle(document.querySelector('.editor-pane')).opacity === '0'");
await replace("前 ");
// 透明输入层用字符按键事件验证真实键入；Input.insertText 在裁剪层中不能可靠推进原生选区。
for (const text of ["$", "x", "$"]) {
  await c.send("Input.dispatchKeyEvent", { type: "char", text, key: text });
}
check(
  "文档模式复用相同的数学配对逻辑且无隐式写盘",
  (await doc()) === "前 $x$" && (await c.evaluate("!window.__browserDevWrites?.length")),
  JSON.stringify({ doc: await doc(), head: await head() }),
);

const originalAgent = await c.evaluate(
  "({userAgent:navigator.userAgent,platform:navigator.platform})",
);
try {
  await c.send("Emulation.setUserAgentOverride", {
    userAgent: originalAgent.userAgent.replace(/\([^)]*\)/, "(Linux; Android 14)"),
    platform: "Linux armv8l",
  });
  await boot(c, DEV_URL);
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await replace("");
  await c.waitFor("!!window.__typstPadView.contentDOM.editContext");
  await c.evaluate(
    "window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionstart'));true",
  );
  await c.type("$");
  await c.evaluate(
    "window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionend'));true",
  );
  check("原生 EditContext 合成中的 $ 也不自动配对", (await doc()) === "$");
  await replace("");
  await c.type("$");
  await c.evaluate(
    "window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionstart'));true",
  );
  await c.type(" ");
  await c.evaluate(
    "window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionend'));true",
  );
  check("原生 EditContext 合成空格不触发行间手势", (await doc()) === "$ $");
} finally {
  await c.send("Emulation.setUserAgentOverride", originalAgent);
  await c.close();
}
finish(`通过 ${state.passed} 项检查；$ 数学定界符补全`);
