// 字体列表工厂的单测：扫描目录要归一化、默认族不许被空列表覆盖、loading 一律复位、
// 「添加目录」取消时什么都不做。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFontList } from "./font-list";
import type { FontListHooks } from "./font-list";

describe("createFontList", () => {
  let families: string[];
  let defaults: string[];
  let loading: boolean[];
  let dirs: string[];
  let listedDirs: string[][];
  let pickedDir: string | null;
  let listError: unknown;
  let defaultValues: string[];

  function make(overrides: Partial<FontListHooks> = {}) {
    return createFontList({
      listFamilies: async (d) => {
        listedDirs.push(d);
        if (listError !== undefined) throw listError;
        return ["Libertinus Serif", "SimSun"];
      },
      defaultFamilies: async () => defaultValues,
      pickDir: async () => pickedDir,
      setFamilies: (v) => {
        families = v;
      },
      setDefaults: (v) => {
        defaults = v;
      },
      setLoading: (v) => {
        loading.push(v);
      },
      dirs: () => dirs,
      setDirs: (v) => {
        dirs = v;
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    families = [];
    defaults = ["Libertinus Serif"]; // 启动时已经取过一次的那份
    loading = [];
    dirs = [];
    listedDirs = [];
    pickedDir = null;
    listError = undefined;
    defaultValues = ["Libertinus Serif", "Noto Serif CJK SC"];
  });

  it("refresh：目录**归一化后**才交给 Rust（trim / 去空 / 去重），并落回列表", async () => {
    const list = make();
    await list.refresh([" /fonts/a ", "/fonts/a", "", "/fonts/b"]);
    expect(listedDirs).toEqual([["/fonts/a", "/fonts/b"]]);
    expect(families).toEqual(["Libertinus Serif", "SimSun"]);
    expect(loading).toEqual([true, false]);
  });

  it("refresh：默认族非空时覆盖；为空时**保留原来那份**（别把兜底字体清空）", async () => {
    const list = make();
    await list.refresh([]);
    expect(defaults).toEqual(["Libertinus Serif", "Noto Serif CJK SC"]);

    defaultValues = [];
    await list.refresh([]);
    expect(defaults).toEqual(["Libertinus Serif", "Noto Serif CJK SC"]);
  });

  it("refresh：Rust 扫描抛错时 loading 仍然复位（下拉不能永远转圈），错误继续抛给全局兜底", async () => {
    listError = "目录不存在";
    const list = make();
    await expect(list.refresh(["/nope"])).rejects.toBe("目录不存在");
    expect(loading).toEqual([true, false]);
  });

  it("addDir：目录选择器取消（null）→ 不写草稿、不扫描", async () => {
    pickedDir = null;
    const list = make();
    await list.addDir();
    expect(dirs).toEqual([]);
    expect(listedDirs).toEqual([]);
    expect(loading).toEqual([]);
  });

  it("addDir：选中目录 → 追加到草稿（归一化去重）并用**新列表**扫描", async () => {
    dirs = ["/fonts/a"];
    pickedDir = " /fonts/a ";
    const list = make();
    await list.addDir();
    expect(dirs).toEqual(["/fonts/a"]); // 重复目录不会变成两条
    expect(listedDirs).toEqual([["/fonts/a"]]);

    pickedDir = "/fonts/b";
    await list.addDir();
    expect(dirs).toEqual(["/fonts/a", "/fonts/b"]);
    expect(listedDirs).toEqual([["/fonts/a"], ["/fonts/a", "/fonts/b"]]);
  });

  it("removeDir：从草稿里删掉那个目录 → 用剩下的列表重新扫描（同步返回，不 await）", async () => {
    dirs = ["/fonts/a", "/fonts/b"];
    const list = make();
    list.removeDir("/fonts/a");
    expect(dirs).toEqual(["/fonts/b"]);
    await vi.waitFor(() => expect(listedDirs).toEqual([["/fonts/b"]]));
  });

  it("removeDir：目录不存在时列表原样（不误删别人的目录）", async () => {
    dirs = ["/fonts/a"];
    const list = make();
    list.removeDir("/fonts/zzz");
    expect(dirs).toEqual(["/fonts/a"]);
    await vi.waitFor(() => expect(listedDirs).toEqual([["/fonts/a"]]));
  });
});
