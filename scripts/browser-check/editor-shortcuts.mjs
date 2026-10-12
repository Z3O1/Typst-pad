// 编辑器快捷键：Ctrl+Shift+D 复用 CodeMirror 的 selectNextOccurrence，Ctrl+D 仍是删除当前行。
// 本套件不依赖页面夹具，验证真实 CDP 按键在源码/写作两模式下都走预期命令。
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep, COMPILE_IDLE } from "./harness.mjs";

const { check, state } = createChecker();
const c = await connect();

await boot(c, DEV_URL);

const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const ranges = () =>
  c.evaluate("window.__typstPadView.state.selection.ranges.map(r=>({from:r.from,to:r.to}))");
const setDoc = (text, anchor = 0) =>
  c.evaluate(`(() => {
    const v = window.__typstPadView;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(text)} },
      selection: { anchor: ${anchor} },
    });
    v.focus();
    return true;
  })()`);

// ---------- 源码模式 ----------
await setDoc("foo bar foo", 1);
await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
check("源码模式：空选区 Ctrl+Shift+D 选中当前词", (await doc()) === "foo bar foo");
check(
  "源码模式：首击只选中第一个 foo",
  JSON.stringify(await ranges()) === JSON.stringify([{ from: 0, to: 3 }]),
);

await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
const twoRanges = await ranges();
check("源码模式：再按追加第二个 foo", (await doc()) === "foo bar foo");
check(
  "源码模式：形成两个不重叠选区",
  twoRanges.length === 2 &&
    twoRanges[0].from === 0 &&
    twoRanges[0].to === 3 &&
    twoRanges[1].from === 8 &&
    twoRanges[1].to === 11,
);

await c.type("X");
check("源码模式：多选区同时输入替换", (await doc()) === "X bar X");

await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
await sleep(80);
check("源码模式：撤销后文档恢复", (await doc()) === "foo bar foo");
check("源码模式：撤销后保留两个选区", (await ranges()).length === 2);

await c.key("Escape", { code: "Escape", keyCode: 27 });
const afterEsc = await ranges();
check(
  "源码模式：Esc 收拢到主选区",
  afterEsc.length === 1 && afterEsc[0].from === 0 && afterEsc[0].to === 3,
);

await setDoc("foo bar foo", 0);
await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
const singleOnly = await ranges();
check(
  "源码模式：无下一匹配时不环回",
  (await doc()) === "foo bar foo" &&
    singleOnly.length === 1 &&
    singleOnly[0].from === 0 &&
    singleOnly[0].to === 3,
);

await setDoc("aaa\nbbb\nccc\n", 4);
await c.key("d", { code: "KeyD", keyCode: 68, modifiers: 2 });
check("源码模式：Ctrl+D 仍是删除当前行", (await doc()) === "aaa\nccc\n");

// ---------- 写作模式 ----------
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.waitFor(COMPILE_IDLE);

await setDoc("foo bar foo", 1);
await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
check("写作模式：Ctrl+Shift+D 不复制当前行", (await doc()) === "foo bar foo");
check(
  "写作模式：空选区选中当前词",
  JSON.stringify(await ranges()) === JSON.stringify([{ from: 0, to: 3 }]),
);

await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
await c.type("X");
await sleep(100);
check("写作模式：多选区同时输入替换", (await doc()) === "X bar X");

await setDoc("aaa\nbbb\nccc\n", 4);
await c.key("d", { code: "KeyD", keyCode: 68, modifiers: 2 });
check("写作模式：Ctrl+D 仍是删除当前行", (await doc()) === "aaa\nccc\n");

finish(`通过 ${state.passed} 项检查`);
