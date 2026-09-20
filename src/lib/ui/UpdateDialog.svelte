<script lang="ts">
  // 更新弹窗（原来内联在 +page.svelte）。共享外壳样式见 src/lib/ui/modal.css，
  // 这里只有更新说明 / 进度条那几条 `.update-*` 样式。
  //
  // 渲染条件由页面把关：`idle` / `checking` / `latest` 三种状态下页面根本不挂这个组件。
  import { formatProgress, type UpdateFlow } from "../core/update-utils";
  import { renderUpdateNotes } from "./update-notes";

  let {
    flow,
    onInstall,
    onDismiss,
    onClose,
    onRetry,
  }: {
    /** 更新流程状态机（见 update-utils.ts 的 UpdateFlow） */
    flow: UpdateFlow;
    /** 下载并安装 */
    onInstall: () => void;
    /** 「稍后」= 用户选择不更新：此后自动检查只更新状态栏、不再弹窗 */
    onDismiss: () => void;
    /** 只把弹窗收起来（状态栏入口仍在），**不等于**「稍后」 */
    onClose: () => void;
    /** 更新失败后重试（= 手动检查一次） */
    onRetry: () => void;
  } = $props();
</script>

<div class="modal-overlay-static">
  <div class="modal update-modal">
    {#if flow.kind === "available"}
      <h3 class="modal-title">发现新版本</h3>
      <p class="modal-text">当前 v{flow.currentVersion} → 最新 v{flow.version}</p>
      {#if flow.notes}
        <!-- 更新说明是 CHANGELOG 的 Markdown 原文（见 generate-latest-json.mjs）：
             交给 update-notes.ts 渲染成受控子集的安全 HTML，别再退回 <pre> 显示原文 -->
        <div class="update-notes">{@html renderUpdateNotes(flow.notes)}</div>
      {/if}
      <p class="modal-text update-hint">
        下载并安装后应用会自动重启；安装包有签名校验，来源不对会被拒绝。
      </p>
      <div class="modal-actions">
        <button class="modal-btn primary" onclick={onInstall}>下载并安装</button>
        <button class="modal-btn" onclick={onDismiss}>稍后</button>
      </div>
    {:else if flow.kind === "downloading"}
      <h3 class="modal-title">正在下载更新 v{flow.version}</h3>
      <div class="update-progress">
        <div class="update-progress-fill" style="width: {flow.progress.percent ?? 0}%"></div>
      </div>
      <p class="modal-text">{formatProgress(flow.progress)}</p>
      <div class="modal-actions">
        <button class="modal-btn" onclick={onClose}>后台继续下载</button>
      </div>
    {:else if flow.kind === "installing"}
      <h3 class="modal-title">更新已就绪</h3>
      <p class="modal-text">
        应用即将退出并安装 v{flow.version}，安装完成后会自动重新打开。
      </p>
      <p class="modal-text update-hint">有未保存的修改请先返回保存（安装期间窗口会关闭）。</p>
      <div class="modal-actions">
        <!-- Windows 上安装器会自己把应用拉起来；留个关闭按钮是为了非 Windows
             （安装完不退出的平台）不会被一个没有按钮的弹窗卡住 -->
        <button class="modal-btn" onclick={onClose}>关闭</button>
      </div>
    {:else if flow.kind === "error"}
      <h3 class="modal-title">更新失败</h3>
      <p class="modal-text">{flow.message}</p>
      <div class="modal-actions">
        <button class="modal-btn" onclick={onClose}>关闭</button>
        <button class="modal-btn primary" onclick={onRetry}>重试</button>
      </div>
    {/if}
  </div>
</div>

<style>
  /* 页面那条 `* { box-sizing: border-box }` 因 Svelte 作用域命中不了子组件（见 07 分册），
     搬出来的组件要自己声明。 */
  * {
    box-sizing: border-box;
  }

  .update-modal {
    max-width: 560px;
  }

  .update-notes {
    margin: 8px 0 0;
    padding: 8px 12px;
    max-height: 260px;
    overflow-y: auto;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    font-size: 12.5px;
    line-height: 1.7;
    word-break: break-word;
  }

  /* 更新说明是 update-notes.ts 生成的 HTML，元素不在本组件模板里 ⇒ 必须 :global 才命中 */
  .update-notes :global(h4),
  .update-notes :global(h5) {
    margin: 10px 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }

  /* 第一节的小标题不需要上边距，免得贴着一片空白 */
  .update-notes :global(:first-child) {
    margin-top: 0;
  }

  .update-notes :global(p) {
    margin: 0 0 6px;
  }

  .update-notes :global(ul),
  .update-notes :global(ol) {
    margin: 0 0 6px;
    padding-left: 20px;
  }

  .update-notes :global(li) {
    margin: 2px 0;
  }

  .update-notes :global(strong) {
    font-weight: 600;
  }

  .update-notes :global(code) {
    padding: 1px 4px;
    border-radius: 3px;
    /* 这两个值原来是 `var(--bg-hover, …)` / `var(--mono-font, …)`，但那两个自定义属性
       全仓库都没定义过 ⇒ fallback 一直生效。直接写死，免得读的人以为还有主题开关。 */
    background: rgba(128, 128, 128, 0.16);
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
  }

  .update-notes :global(hr) {
    margin: 8px 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .update-hint {
    color: var(--fg-dim);
    font-size: 12px;
  }

  .update-progress {
    height: 6px;
    margin: 12px 0 6px;
    border-radius: 3px;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .update-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s linear; /* 进度回调是分片的，平滑一点免得跳 */
  }
</style>
