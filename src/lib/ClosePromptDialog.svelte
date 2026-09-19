<script lang="ts">
  // 未保存确认弹窗（原来内联在 +page.svelte）。外壳样式见 src/lib/modal.css；这个弹窗没有特有样式。
  let {
    onSave,
    onDiscard,
    onCancel,
  }: {
    onSave: () => void;
    /** 不保存：按未保存内容分支继续（关窗 / 新建 / 打开） */
    onDiscard: () => void;
    /** 取消：窗口继续开着 = Esc 的那条路（见 dismissModal） */
    onCancel: () => void;
  } = $props();
</script>

<div class="modal-overlay-static">
  <div class="modal">
    <h3 class="modal-title">未保存的修改</h3>
    <p class="modal-text">当前文档有未保存的修改，是否保存？</p>
    <div class="modal-actions">
      <button class="modal-btn primary" onclick={onSave}>保存</button>
      <button class="modal-btn" onclick={onDiscard}>不保存</button>
      <button class="modal-btn" onclick={onCancel}>取消</button>
    </div>
  </div>
</div>

<style>
  /* 这个弹窗自己没有特有样式，但**必须**声明这一条：页面那条 `* { box-sizing: border-box }` 会被
     Svelte 的作用域编译成页面的 hash 类，命中不了子组件里的元素（`.modal` 有 padding+border，
     缺了它外框会多出 50px）。见 docs/实现细则/07-测试与审查.md。 */
  * {
    box-sizing: border-box;
  }
</style>
