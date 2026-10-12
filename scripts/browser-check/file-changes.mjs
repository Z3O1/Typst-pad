// 页面文件变更接线验收；假磁盘/事件/延迟 IPC，仅证明前端，不代表原生 watcher 或 WebView2。
// 无真实排版夹具依赖（只核对编译入参与编辑会话），独立运行 21 项断言。
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep, compileSettled, flushStateSeed } from "./harness.mjs";
const c = await connect();
const { check, state } = createChecker();
const fs = "window.__browserDevFileChanges";
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const promptCount = () => c.evaluate(`${fs}.prompts.length`);
const writes = () => c.evaluate("window.__browserDevWrites?.length ?? 0");
async function open(path, content) {
  await c.evaluate(
    `${fs}.setDisk(${JSON.stringify(path)},${JSON.stringify(content)});window.__browserDevConfirm=true;window.__browserDevOpenPath=${JSON.stringify(path)}`,
  );
  await c.key("o", { keyCode: 79, modifiers: 2 });
  await c.waitFor(compileSettled(content));
  await sleep(300);
}
async function edit(text) {
  await c.evaluate("window.__typstPadView.focus()");
  await c.selectAll();
  await c.type(text);
  await c.waitFor(compileSettled(text));
}
async function external(path, content) {
  await c.evaluate(
    `${fs}.setDisk(${JSON.stringify(path)},${JSON.stringify(content)});${fs}.emit(${JSON.stringify(path)})`,
  );
  await sleep(350);
}
await boot(c, DEV_URL, { runtime: true });
await c.key("e", { keyCode: 69, modifiers: 2 });
check(
  "未命名不启动 watch，listener 先就绪",
  await c.evaluate(`${fs}.listenerReady && !${fs}.starts.length`),
);
await open("/fake/a.typ", "base-a");
check("打开后启动当前路径观察", await c.evaluate(`${fs}.watchedPath === '/fake/a.typ'`));
const initialWrites = await writes();
await external("/fake/a.typ", "external-a");
await c.waitFor(compileSettled("external-a"));
check(
  "clean 自动重读且重编译，无写盘",
  (await doc()) === "external-a" && (await writes()) === initialWrites,
);
await c.key("z", { keyCode: 90, modifiers: 2 });
check("自动重读建立无旧撤销历史的新会话", (await doc()) === "external-a");
await edit("local-dirty");
await c.evaluate("window.__browserDevConfirm=false");
let prompts = await promptCount();
await external("/fake/a.typ", "disk-one");
check(
  "dirty keep 保留输入且无隐式 write",
  (await doc()) === "local-dirty" &&
    (await writes()) === initialWrites &&
    (await promptCount()) === prompts + 1,
);
await external("/fake/a.typ", "disk-one");
check("keep 同版本不重复确认", (await promptCount()) === prompts + 1);
await c.evaluate("window.__browserDevConfirm=true");
await external("/fake/a.typ", "disk-two");
await c.waitFor(compileSettled("disk-two"));
check(
  "新的磁盘版本再次提示并重读",
  (await doc()) === "disk-two" && (await promptCount()) === prompts + 2,
);
await c.key("z", { keyCode: 90, modifiers: 2 });
check("dirty reload 清旧撤销历史", (await doc()) === "disk-two");
await edit("undo-local");
await c.key("z", { keyCode: 90, modifiers: 2 });
await c.waitFor(compileSettled("disk-two"));
prompts = await promptCount();
await external("/fake/a.typ", "undo-external");
check(
  "撤销回基线按 clean 自动重读",
  (await doc()) === "undo-external" && (await promptCount()) === prompts,
);

await open("/fake/a.typ", "read-base");
await c.evaluate(`${fs}.read.holdNext=true`);
await external("/fake/a.typ", "late-a");
await c.waitFor(`${fs}.read.pending`);
await open("/fake/b.typ", "b-session");
await c.evaluate(`${fs}.read.release();${fs}.emit('/fake/a.typ')`);
await sleep(350);
check(
  "A→B 的晚 read/event 不覆盖 B",
  (await doc()) === "b-session" && (await c.evaluate(`${fs}.watchedPath === '/fake/b.typ'`)),
);

await open("/fake/a.typ", "prompt-base");
await edit("dirty-prompt");
await c.evaluate(`${fs}.prompt.holdNext=true;window.__browserDevConfirm=true`);
await external("/fake/a.typ", "old-prompt-disk");
await c.waitFor(`${fs}.prompt.pending`);
await open("/fake/a.typ", "same-path-new-session");
await c.evaluate(`${fs}.prompt.release()`);
await sleep(350);
check("同路径新会话让迟到确认作废", (await doc()) === "same-path-new-session");

await edit("prompt-dirty-again");
await c.evaluate(`${fs}.prompt.holdNext=true;window.__browserDevConfirm=true`);
await external("/fake/a.typ", "prompt-external");
await c.waitFor(`${fs}.prompt.pending`);
await edit("typed-during-confirm");
await c.evaluate(`${fs}.prompt.release()`);
await sleep(350);
check("提示期间继续输入不被旧确认覆盖", (await doc()) === "typed-during-confirm");

await open("/fake/a.typ", "save-base");
await edit("save-snapshot");
await c.evaluate(`${fs}.write.holdNext=true`);
await c.key("s", { keyCode: 83, modifiers: 2 });
await c.waitFor(`${fs}.write.pending`);
await edit("save-snapshot-plus-input");
await c.evaluate(`${fs}.write.release()`);
await sleep(120);
prompts = await promptCount();
await c.evaluate(`${fs}.emit('/fake/a.typ')`);
await sleep(350);
check(
  "自己 save + 继续输入不误报，正文仍 dirty",
  (await doc()) === "save-snapshot-plus-input" &&
    (await promptCount()) === prompts &&
    (await c.evaluate("window.__browserDevLastTitle.includes(' •')")),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
check("保存等待期间的撤销历史不丢失", (await doc()) === "save-snapshot");

await edit("late-save-a");
await c.evaluate(`${fs}.write.holdNext=true`);
await c.key("s", { keyCode: 83, modifiers: 2 });
await c.waitFor(`${fs}.write.pending`);
await open("/fake/b.typ", "save-new-session-b");
await c.evaluate(`${fs}.write.release();${fs}.emit('/fake/a.typ')`);
await sleep(350);
check(
  "迟到 save 不修改新会话内容、基线或状态",
  (await doc()) === "save-new-session-b" &&
    (await c.evaluate(
      "!window.__browserDevLastTitle.includes(' •') && window.__browserDevLastCompile.documentPath === '/fake/b.typ'",
    )),
);
await edit("local-before-conflict-save");
await c.evaluate("window.__browserDevConfirm=false");
await external("/fake/b.typ", "save-conflict-version1");
const beforeConflictWrite = await writes();
await c.evaluate(`${fs}.prompt.holdNext=true;window.__browserDevConfirm=true`);
await c.key("s", { keyCode: 83, modifiers: 2 });
await c.waitFor(`${fs}.prompt.pending`);
await c.evaluate(`${fs}.setDisk('/fake/b.typ','save-conflict-version2');${fs}.prompt.release()`);
await sleep(350);
check("保存确认绑定磁盘版本，变化后不执行旧授权写盘", (await writes()) === beforeConflictWrite);

await c.evaluate("window.__browserDevConfirm=true");
await c.key("n", { keyCode: 78, modifiers: 2 });
await c.waitFor(`${fs}.watchedPath === null`);
check("新建解绑当前路径监控", (await doc()) === "" && (await c.evaluate(`${fs}.stops > 0`)));
await edit("save-as-text");
await c.evaluate("window.__browserDevSavePath='/fake/new.typ'");
await c.key("s", { keyCode: 83, modifiers: 2 });
await c.waitFor(`${fs}.watchedPath === '/fake/new.typ'`);
check(
  "另存为改路径且保留内容",
  (await doc()) === "save-as-text" && (await c.evaluate(`${fs}.starts.at(-1) === '/fake/new.typ'`)),
);
await flushStateSeed(c, {
  content: "restored-unsaved",
  filePath: "/fake/restored.typ",
  fileTitle: "restored.typ",
  dirty: true,
  restoreSession: true,
  viewMode: "source",
  autoCheckUpdates: false,
});
await c.goto(DEV_URL);
await c.waitFor(`${fs}.prompts.length > 0`);
check(
  "恢复未知基线按 dirty，不自动覆写或写盘",
  (await doc()) === "restored-unsaved" && (await writes()) === 0,
);
const errors = await c.evaluate("document.querySelector('.statusbar')?.textContent ?? ''");
check(
  "恢复与未命名流程无 getCurrentWindow 异常",
  !/getCurrentWindow|__TAURI_INTERNALS__|TypeError/.test(errors),
);
await c.send("Page.navigate", { url: DEV_URL.replace(/\?.*$/, "") });
await sleep(500);
check(
  "非 Tauri 页面无需窗口 IPC",
  await c.evaluate(
    "!window.__TAURI_INTERNALS__ && !/TypeError|getCurrentWindow/.test(document.body.textContent)",
  ),
);
await c.close();
finish(`通过 ${state.passed} 项检查；文件变更页面接线（${state.failed} 失败，无真实排版夹具依赖）`);
