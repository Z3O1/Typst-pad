// 和 CM closeBrackets 一样记录自动补出的闭合符，不把打开/粘贴的源码当成待跳过字符。
// 同时记录起点，以便行间公式展开后仍能在多行内部保持配对状态。
import { MapMode, StateEffect, StateField } from "@codemirror/state";
import type { ChangeDesc } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

export interface DollarPair {
  open: number;
  close: number;
  display: boolean;
}

function mapPair(pair: DollarPair, changes: ChangeDesc): DollarPair | undefined {
  const open = changes.mapPos(pair.open, 1, MapMode.TrackAfter);
  const close = changes.mapPos(pair.close, 1, MapMode.TrackAfter);
  return open !== null && close !== null && open < close ? { ...pair, open, close } : undefined;
}

export const addDollarPair = StateEffect.define<DollarPair>({ map: mapPair });
export const consumeDollarPair = StateEffect.define<number>({
  map: (pos, changes) => changes.mapPos(pos, 1, MapMode.TrackAfter) ?? undefined,
});
const restoreDollarPairs = StateEffect.define<readonly DollarPair[]>({
  map: (pairs, changes) => pairs.flatMap((pair) => mapPair(pair, changes) ?? []),
});

export const dollarPairs = StateField.define<readonly DollarPair[]>({
  create: () => [],
  update(pairs, tr) {
    let next = pairs.flatMap((pair) => mapPair(pair, tr.changes) ?? []);
    if (tr.selection) {
      next = next.filter((pair) => {
        const from = tr.state.doc.lineAt(pair.open).from;
        const to = tr.state.doc.lineAt(pair.close).to;
        return tr.state.selection.ranges.some((range) => range.head >= from && range.head <= to);
      });
    }
    for (const effect of tr.effects) {
      if (effect.is(restoreDollarPairs)) next = [...effect.value];
      if (effect.is(consumeDollarPair)) next = next.filter((pair) => pair.close !== effect.value);
      if (effect.is(addDollarPair)) {
        next = next.filter((pair) => pair.close !== effect.value.close);
        next.push(effect.value);
      }
    }
    // 开闭定界符被删除、替换或整个文档被重读后，不保留旧会话的跳过状态。
    return next.filter(
      (pair) =>
        pair.open >= 0 &&
        pair.close < tr.newDoc.length &&
        tr.newDoc.sliceString(pair.open, pair.open + 1) === "$" &&
        tr.newDoc.sliceString(pair.close, pair.close + 1) === "$",
    );
  },
});

// 文档撤销/重做同时恢复配对状态；纯光标跳过不单独产生一个撤销步骤。
export const dollarPairHistory = invertedEffects.of((tr) => {
  if (!tr.docChanged) return [];
  const before = tr.startState.field(dollarPairs);
  return before.length || tr.state.field(dollarPairs).length ? [restoreDollarPairs.of(before)] : [];
});
