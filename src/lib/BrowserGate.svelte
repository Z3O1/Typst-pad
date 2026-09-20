<script lang="ts">
  // 非 Tauri（浏览器直开）时的提示页。
  //
  // 开发模式下额外给一键入口：浏览器开发模式（?browserdev=1）会装假的 Tauri 环境 + 假编译，
  // 能完整调试编辑器交互（所见即所得、快捷键、菜单、分栏），只是没有真实 typst 排版与文件功能。
  // 不加这个入口时，裸开 http://localhost:1420/ 只会看到"请使用桌面应用版本"，
  // 很容易误判成"用不了了"（实测踩过）。生产构建（非 DEV）不显示该入口。
  //
  // 主题变量（--bg / --fg / --accent …）来自页面样式块里的 `:root`（CSS 变量会继承到组件）。
  // 按钮用的 `.modal-btn primary` 在全局的 modal.css 里（页面已 import），所以这里不必重写。

  /** 一键切到浏览器开发模式（只加查询参数，不丢其它参数） */
  function openBrowserDev() {
    const url = new URL(location.href);
    url.searchParams.set("browserdev", "1");
    location.href = url.toString();
  }
</script>

<div class="browser-gate">
  <p class="browser-gate-title">请使用桌面应用版本</p>
  <p class="browser-gate-text">Typst-pad 已移除浏览器支持，请下载桌面应用后使用。</p>
  {#if import.meta.env.DEV}
    <p class="browser-gate-text browser-gate-dev">
      开发调试可改用<strong>浏览器开发模式</strong>：带 <code>?browserdev=1</code> 打开本页 （假 Tauri
      环境 + 假编译，可调试编辑器交互与所见即所得）。
    </p>
    <button class="modal-btn primary" onclick={openBrowserDev}>打开浏览器开发模式</button>
  {/if}
</div>

<style>
  /* 页面那条 `* { box-sizing: border-box }` 因 Svelte 作用域命中不了子组件（见 07 分册），
     搬出来的组件要自己声明。 */
  * {
    box-sizing: border-box;
  }

  /* 浏览器提示页（非 Tauri 环境；已移除浏览器支持） */
  .browser-gate {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--bg);
    color: var(--fg);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }

  .browser-gate-title {
    margin: 0;
    font-size: 18px;
    color: var(--accent);
  }

  .browser-gate-dev {
    max-width: 520px;
    line-height: 1.7;
  }

  .browser-gate-dev code {
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.25);
  }

  .browser-gate-text {
    margin: 0;
    font-size: 13px;
    color: var(--fg-dim);
  }
</style>
