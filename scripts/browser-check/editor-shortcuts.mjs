// 编辑器快捷键：Ctrl+Shift+D 复用 CodeMirror 的 selectNextOccurrence，Ctrl+D 仍是删除当前行。
// 本套件不依赖页面夹具，在 source / write 两种实际模式下分别验证真实 CDP 按键行为。
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

/**
 * 通过可见布局推断当前模式：
 * - write（文档模式）：.panes 带 .document-mode，.editor-pane.input-proxy 透明度为 0；
 * - source（源码模式）：.panes 不带 .document-mode，编辑器可见。
 */
const currentMode = () =>
  c.evaluate(`(() => {
    const panes = document.querySelector('.panes');
    const editor = document.querySelector('.editor-pane');
    if (!panes || !editor) return 'unknown';
    const isDocumentMode = panes.classList.contains('document-mode');
    const opacity = parseFloat(getComputedStyle(editor).opacity || '1');
    return isDocumentMode && opacity === 0 ? 'write' : 'source';
  })()`);

async function ensureMode(expected) {
  const actual = await currentMode();
  if (actual === expected) return;
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.waitFor(COMPILE_IDLE);
  const now = await currentMode();
  if (now !== expected) {
    throw new Error(`无法切换到 ${expected} 模式，当前为 ${now}`);
  }
}

async function runModeTests(mode) {
  await ensureMode(mode);
  check(`${mode}: 当前模式断言`, (await currentMode()) === mode);

  await setDoc("foo bar foo", 1);
  await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
  check(`${mode}: 空选区 Ctrl+Shift+D 选中当前词（不改文档）`, (await doc()) === "foo bar foo");
  check(
    `${mode}: 首击只选中第一个 foo`,
    JSON.stringify(await ranges()) === JSON.stringify([{ from: 0, to: 3 }]),
  );

  await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
  const twoRanges = await ranges();
  check(`${mode}: 再按追加第二个 foo`, (await doc()) === "foo bar foo");
  check(
    `${mode}: 形成两个不重叠选区`,
    twoRanges.length === 2 &&
      twoRanges[0].from === 0 &&
      twoRanges[0].to === 3 &&
      twoRanges[1].from === 8 &&
      twoRanges[1].to === 11,
  );

  await c.type("X");
  check(`${mode}: 多选区同时输入替换`, (await doc()) === "X bar X");

  await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
  await sleep(80);
  check(`${mode}: 撤销后文档恢复`, (await doc()) === "foo bar foo");
  check(`${mode}: 撤销后保留两个选区`, (await ranges()).length === 2);

  await c.key("Escape", { code: "Escape", keyCode: 27 });
  const afterEsc = await ranges();
  check(
    `${mode}: Esc 收拢到主选区`,
    afterEsc.length === 1 && afterEsc[0].from === 0 && afterEsc[0].to === 3,
  );

  await setDoc("foo bar foo", 0);
  await c.key("D", { code: "KeyD", keyCode: 68, modifiers: 10 });
  const singleOnly = await ranges();
  check(
    `${mode}: 无下一匹配时不环回`,
    (await doc()) === "foo bar foo" &&
      singleOnly.length === 1 &&
      singleOnly[0].from === 0 &&
      singleOnly[0].to === 3,
  );

  await setDoc("aaa\nbbb\nccc\n", 4);
  await c.key("d", { code: "KeyD", keyCode: 68, modifiers: 2 });
  check(`${mode}: Ctrl+D 仍是删除当前行`, (await doc()) === "aaa\nccc\n");
}

// 默认启动模式是 write（document mode），先用断言确认，再切到 source 跑第二轮。
await runModeTests("write");
await runModeTests("source");

finish(`通过 ${state.passed} 项检查`);
