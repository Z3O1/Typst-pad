// 粘贴管线：图片写进文档所在目录并插 #image、纯文本兜底、Ctrl+Shift+V、失败与切文档护栏。
// 用真实 DOM 的 DataTransfer + ClipboardEvent 走一遍剪贴板事件路径（桩只替代磁盘写入）。
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep } from "./harness.mjs";
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL);
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const status = () => c.evaluate("document.querySelector('.status-text').textContent");
const binaryWrites = () => c.evaluate("window.__browserDevBinaryWrites ?? []");
const replace = async (text) => {
  await c.evaluate(`(() => {
    const view = window.__typstPadView;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(text)} },
      selection: { anchor: ${text.length} },
      annotations: view.state.update({}).constructor.time.of(0),
    });
    view.focus();
    return true;
  })()`);
  await sleep(120);
};
/** 剪贴板事件：真实 DataTransfer + ClipboardEvent，派发到编辑器内容层 */
const firePaste = async ({ files = 0, text = "", html = "" } = {}) => {
  await c.evaluate(`(() => {
    const view = window.__typstPadView;
    const dt = new DataTransfer();
    ${Array.from(
      { length: files },
      (_, i) =>
        `dt.items.add(new File([new Uint8Array([1,2,3,${i}])], 'shot${i}.png', {type:'image/png'}));`,
    ).join("\n    ")}
    ${text === "" ? "" : `dt.setData("text/plain", ${JSON.stringify(text)});`}
    ${html === "" ? "" : `dt.setData("text/html", ${JSON.stringify(html)});`}
    view.contentDOM.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
    return true;
  })()`);
  await sleep(200);
};
const saveTo = async (path) => {
  await c.evaluate(`window.__browserDevSavePath = ${JSON.stringify(path)}`);
  await c.key("s", { keyCode: 83, modifiers: 2 });
  await sleep(200);
};
const snippets = async () => (await doc()).match(/#image\("[^"]*"\)/g) ?? [];
// 写盘是异步的：所有断言都等到可观测结果真正落地（不靠固定 sleep 猜时间）
const waitDoc = (expected) =>
  c.waitFor(`window.__typstPadView.state.doc.toString() === ${JSON.stringify(expected)}`, {
    timeout: 4000,
  });
const waitSnippets = (count) =>
  c.waitFor(
    `(window.__typstPadView.state.doc.toString().split('#image("').length - 1) === ${count}`,
    { timeout: 4000 },
  );
const waitStatus = (text) =>
  c.waitFor(
    `document.querySelector('.status-text').textContent.includes(${JSON.stringify(text)})`,
    { timeout: 4000 },
  );

check(
  "启动即文档模式（粘贴接线在编辑层生效）",
  await c.evaluate("!!document.querySelector('.document-pane')"),
);

// ① 已保存文档：图片写到文档所在目录，源码插相对路径。
await replace("正文\n");
await saveTo("/fake/dir/doc.typ");
const beforeWrites = (await binaryWrites()).length;
const beforeTextWrites = await c.evaluate("window.__browserDevWrites?.length ?? 0");
await firePaste({ files: 1 });
await waitSnippets(1);
const writes = await binaryWrites();
const written = writes[writes.length - 1] ?? {};
const firstSnippet = (await snippets())[0] ?? "";
const relative = firstSnippet.replace(/^#image\("|"\)$/g, "");
check(
  "图片写在文档所在目录，字节来自剪贴板文件",
  writes.length === beforeWrites + 1 &&
    /^\/fake\/dir\/image-\d{8}-\d{6}-\d+\.png$/.test(written.path) &&
    written.bytes === 4,
  JSON.stringify(written),
);
check(
  "源码插入相对路径的 #image，光标落在其后",
  firstSnippet !== "" &&
    written.path === `/fake/dir/${relative}` &&
    (await c.evaluate("window.__typstPadView.state.selection.main.head")) === (await doc()).length,
  `${firstSnippet} / ${written.path}`,
);
check(
  "粘贴图片不重写 .typ 文件（唯一写盘是图片）",
  (await c.evaluate("window.__browserDevWrites?.length ?? 0")) === beforeTextWrites,
);

// ② 同一处连贴两张：两张都落盘，源码分段不挤成一行。
const before2 = (await binaryWrites()).length;
await firePaste({ files: 2 });
await waitSnippets(3);
const twoWrites = await binaryWrites();
check(
  "两张图片各自落盘并分成两段",
  twoWrites.length === before2 + 2 &&
    (await snippets()).length === 3 &&
    /\n\n#image\("/.test(await doc()),
  await doc(),
);

// ③ 写盘失败：只提示原因，不插入半截源码。
await c.evaluate("window.__browserDevBinaryFailure.message = '磁盘已满'");
await replace("甲\n");
const beforeFail = (await binaryWrites()).length;
await firePaste({ files: 1 });
await waitStatus("磁盘已满");
check(
  "写盘失败不插入源码，状态栏给出原因",
  (await binaryWrites()).length === beforeFail + 1 &&
    (await doc()) === "甲\n" &&
    (await status()).includes("磁盘已满"),
  `${await doc()} / ${await status()}`,
);

// ④ Ctrl+Shift+V 对图片没有可选形态：仍然按图片处理。
await replace("");
await c.key("v", { keyCode: 86, modifiers: 2 | 8 });
await sleep(50);
await firePaste({ files: 1 });
await waitSnippets(1);
check(
  "Ctrl+Shift+V 粘贴图片仍走图片链路",
  (await snippets()).length === 1 && (await doc()).startsWith('#image("'),
  await doc(),
);

// ⑤ 只有 HTML 的剪贴板：抽成纯文本，段落之间保留空行。
await replace("");
await firePaste({ html: "<p>甲</p><p>乙</p><ul><li>丙</li></ul>" });
await waitDoc("甲\n\n乙\n- 丙");
check("只有 HTML 时抽成纯文本并保留段落与列表", (await doc()) === "甲\n\n乙\n- 丙", await doc());

// ⑥ Ctrl+Shift+V：同时有 text/plain 与 text/html 时只取纯文本。
await replace("");
await c.key("v", { keyCode: 86, modifiers: 2 | 8 });
await sleep(50);
await firePaste({ text: "甲 乙", html: "<p>甲&nbsp;&nbsp;乙</p>" });
await waitDoc("甲 乙");
check("Ctrl+Shift+V 只插纯文本", (await doc()) === "甲 乙", await doc());

// ⑦ 未保存的文档：拒绝写盘并说明原因（不猜目录、不隐式写盘）。
await c.evaluate("window.__browserDevConfirm = true");
await c.key("n", { keyCode: 78, modifiers: 2 });
await sleep(200);
await replace("未保存\n");
const unsavedWrites = (await binaryWrites()).length;
await firePaste({ files: 1 });
await waitStatus("请先保存文档");
check(
  "未保存文档粘贴图片被拒绝且不写盘",
  (await binaryWrites()).length === unsavedWrites &&
    (await doc()) === "未保存\n" &&
    (await status()).includes("请先保存文档"),
  `${await doc()} / ${await status()}`,
);

// ⑧ 写盘期间换文档（新建）：迟到的结果只提示文件名，不往新文档插源码。
await saveTo("/fake/dir/held.typ");
await replace("旧文档\n");
await c.evaluate("window.__browserDevBinaryHold.holdNext = true");
await firePaste({ files: 1 });
await c.key("n", { keyCode: 78, modifiers: 2 });
await sleep(150);
const afterNew = await doc();
await c.evaluate("window.__browserDevBinaryHold.release()");
await waitStatus("文档已切换");
check(
  "写盘期间换文档：新文档不被写入旧粘贴结果",
  afterNew === "" && (await doc()) === "" && (await status()).includes("文档已切换"),
  `${await doc()} / ${await status()}`,
);

finish(`通过 ${state.passed} 项检查；粘贴管线`);
