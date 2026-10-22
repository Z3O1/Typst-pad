// 最近字形算法；真实连字、前缀映射和快照身份由整页交互测试覆盖。
use super::*;

#[test]
fn pick_hit_chooses_the_clicked_glyph() {
    let items = vec![
        item(1, 0..3, 0.0, 10.0, 10.0, 20.0),
        item(1, 3..6, 10.0, 10.0, 20.0, 20.0),
        item(1, 6..9, 20.0, 10.0, 30.0, 20.0),
        item(1, 9..12, 0.0, 30.0, 10.0, 40.0),
        item(1, 12..15, 10.0, 30.0, 20.0, 40.0),
        item(2, 0..3, 0.0, 10.0, 10.0, 20.0),
        item(1, 100..103, 0.0, 10.0, 10.0, 20.0),
    ];
    let pick = |start, end, page, x, y| {
        pick_hit_item(&items, start, end, page, Abs::pt(x), Abs::pt(y)).map(|(_, offset)| offset)
    };
    assert_eq!(pick(0, 15, 1, 2.0, 15.0), Some(0), "第一个字左半");
    assert_eq!(pick(0, 15, 1, 8.0, 15.0), Some(3), "第一个字右半");
    assert_eq!(pick(0, 15, 1, 25.0, 15.0), Some(9), "第三个字右半");
    assert_eq!(pick(0, 15, 1, 200.0, 15.0), Some(9), "行右侧空白");
    assert_eq!(pick(0, 15, 1, -50.0, 15.0), Some(0), "行左侧空白");
    assert_eq!(pick(0, 15, 1, 2.0, 35.0), Some(9), "第二行行首");
    assert_eq!(pick(0, 15, 1, 15.0, 35.0), Some(15), "第二行第二字");
    assert_eq!(pick(0, 9, 1, 2.0, 15.0), Some(0), "其他源区间不参与");
    assert_eq!(pick(1000, 1003, 1, 2.0, 15.0), None, "无对应源区间");
    assert_eq!(pick(0, 15, 9, 2.0, 15.0), None, "无对应页面");
}
