<script lang="ts">
  // 关于弹窗（原来内联在 +page.svelte）。共享外壳样式在 src/lib/modal.css，
  // 这里只有"正文长一点"这两条弹窗特有的规则。
  let {
    version,
    projectUrl,
    onClose,
    onOpenProject,
  }: {
    /** 运行时读到的应用版本（拿不到时显示占位符） */
    version: string;
    /** 项目主页地址（开源仓库） */
    projectUrl: string;
    onClose: () => void;
    onOpenProject: () => void;
  } = $props();
</script>

<!-- 点遮罩空白处关闭（遮罩本身是按钮；点到面板上不算） -->
<button
  class="modal-overlay"
  aria-label="关闭关于窗口"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="modal about-modal">
    <h3 class="modal-title">Typst-pad</h3>
    <p class="modal-text">版本 {version || "…"}</p>
    <p class="modal-text">
      仿 Typora 的 Typst 桌面编辑器：<strong>写作模式</strong>（默认）整页纸张，公式与标记就地排版，
      光标 / 选区进入即展开源码；<strong>源代码模式</strong>（Ctrl+E）双栏对照，源码 + 整页预览。
    </p>
    <p class="modal-text">
      排版由<strong>内置的 typst 引擎</strong>在本机完成：不联网，文档不出本机。
    </p>
    <p class="modal-text about-note">
      MIT License © 2026 Z3O1 · 内置字体 Noto Serif CJK / Libertinus / New Computer Modern / DejaVu
      Sans Mono 遵循各自的开源许可
    </p>
    <div class="modal-actions">
      <span
        class="modal-close"
        role="button"
        tabindex="0"
        title={projectUrl}
        onclick={onOpenProject}
        onkeydown={(e) => e.key === "Enter" && onOpenProject()}
      >项目主页</span>
      <span
        class="modal-close"
        role="button"
        tabindex="0"
        onclick={onClose}
        onkeydown={(e) => e.key === "Enter" && onClose()}
      >关闭</span>
    </div>
  </div>
</button>

<style>
  /* 从页面搬出来的组件**必须自己声明这条**：页面的 `* { box-sizing: border-box }` 会被 Svelte
     的作用域编译成 `.svelte-<页面hash>`，命中不了子组件里的元素（拆组件时踩过：弹窗宽度多出
     padding+border、状态栏内容区变窄、错误框横向溢出。见 docs/实现细则/07-测试与审查.md）。 */
  * {
    box-sizing: border-box;
  }

  /* 关于弹窗：正文长一点，限宽换行才好看（其余弹窗是标签 + 输入框，不需要） */
  .about-modal {
    max-width: 460px;
    line-height: 1.7;
  }

  .about-note {
    font-size: 12px;
    color: var(--fg-dim);
  }
</style>
