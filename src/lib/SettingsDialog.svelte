<script lang="ts">
  // 设置弹窗（原来内联在 +page.svelte）。共享外壳样式见 src/lib/modal.css，
  // 这里只有设置面板特有的 `.settings-*` 样式。
  //
  // 面板里的值全是**草稿**（页面上的 settings* 系列）：打开时从生效值拷一份，点「保存」才生效
  // （见 +page.svelte 的 openSettings / saveSettings），所以用 $bindable 让页面继续持有草稿状态。
  import { prefixLineCharOffset } from "./error-list";
  import { FONT_CHOICE_DEFAULT } from "./font-settings";

  let {
    restoreSession = $bindable(),
    autoCheckUpdates = $bindable(),
    prefixEnabled = $bindable(),
    prefixCode = $bindable(),
    chineseFont = $bindable(),
    fontDirs = $bindable(),
    availableFonts,
    fontsLoading,
    onAddFontDir,
    onRemoveFontDir,
    onSave,
    onClose,
  }: {
    restoreSession: boolean;
    autoCheckUpdates: boolean;
    prefixEnabled: boolean;
    prefixCode: string;
    chineseFont: string;
    fontDirs: string[];
    availableFonts: string[];
    fontsLoading: boolean;
    onAddFontDir: () => void;
    onRemoveFontDir: (dir: string) => void;
    onSave: () => void;
    onClose: () => void;
  } = $props();

  let prefixTextarea = $state<HTMLTextAreaElement | undefined>(undefined);

  /**
   * 在前缀代码 textarea 里定位第 line 行的行首。供页面在"错误落在前缀代码内"时调用
   * （+page.svelte 的 onDiagnosticItemClick：openSettings 之后等一个 tick 再调，
   * 那时这个 textarea 才渲染出来）。偏移按**当前草稿**的前缀代码算。
   */
  export function focusPrefixLine(line: number) {
    const textarea = prefixTextarea;
    if (!textarea) return;
    const offset = prefixLineCharOffset(prefixCode, line);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    textarea.scrollIntoView({ block: "nearest" });
  }
</script>

<div class="modal-overlay-static">
  <div class="modal settings-modal">
    <h3 class="modal-title">设置</h3>
    <p class="modal-text">编译/导出时自动在代码前插入前缀代码（可配置页面、字体等全局项）。</p>
    <label class="settings-row">
      <input type="checkbox" bind:checked={restoreSession} />
      <span>启动时恢复上次内容（未保存的修改不会丢）</span>
    </label>
    <label class="settings-row">
      <input type="checkbox" bind:checked={autoCheckUpdates} />
      <span>启动时自动检查更新（发现新版本会先询问，不会自己下载）</span>
    </label>
    <label class="settings-row">
      <input type="checkbox" bind:checked={prefixEnabled} />
      <span>启用前缀代码</span>
    </label>
    <textarea
      class="settings-textarea"
      bind:value={prefixCode}
      bind:this={prefixTextarea}
      placeholder="#set page(margin: 2cm)"
      spellcheck="false"
    ></textarea>
    <label class="settings-row settings-row-font">
      <span>正文字体（中文）</span>
      <select class="settings-select" bind:value={chineseFont}>
        <option value={FONT_CHOICE_DEFAULT}>默认（思源宋体，缺字回退系统宋体）</option>
        {#each availableFonts as font (font)}
          <option value={font}>{font}</option>
        {/each}
      </select>
    </label>
    <p class="settings-hint">
      只认字体文件里的英文族名；用「额外字体目录」加入自己的字体后，这里会多出对应选项。
    </p>
    <div class="settings-block">
      <div class="settings-block-title">
        额外字体目录（放进这里的字体立即可用，等同于 typst CLI 的 --font-path）
      </div>
      {#each fontDirs as dir (dir)}
        <div class="settings-dir">
          <span class="settings-dir-path" title={dir}>{dir}</span>
          <button class="modal-btn" onclick={() => onRemoveFontDir(dir)}>移除</button>
        </div>
      {/each}
      <div class="settings-dir-actions">
        <button class="modal-btn" onclick={onAddFontDir} disabled={fontsLoading}>添加字体目录…</button>
        {#if fontsLoading}
          <span class="settings-hint">正在读取字体…</span>
        {:else if availableFonts.length > 0}
          <span class="settings-hint">可用字体族 {availableFonts.length} 个</span>
        {/if}
      </div>
    </div>
    <div class="modal-actions">
      <button class="modal-btn primary" onclick={onSave}>保存</button>
      <button class="modal-btn" onclick={onClose}>关闭</button>
    </div>
  </div>
</div>

<style>
  .settings-modal {
    width: 520px;
    max-width: 90vw;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0 4px;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }

  .settings-row input[type="checkbox"] {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
  }

  .settings-textarea {
    width: 100%;
    min-height: 160px;
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    font-family: Consolas, "Cascadia Code", "Courier New", monospace;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
    box-sizing: border-box;
  }

  .settings-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .settings-row-font {
    justify-content: space-between;
    cursor: default;
  }

  .settings-select {
    max-width: 260px;
    padding: 4px 6px;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--fg);
    font-size: 13px;
  }

  .settings-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 10px 0 4px;
  }

  .settings-block-title {
    color: var(--fg-dim);
    font-size: 12px;
  }

  .settings-hint {
    margin: 2px 0;
    color: var(--fg-dim);
    font-size: 12px;
  }

  .settings-dir {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .settings-dir-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
  }

  .settings-dir-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
