// fetchFontBuffers：并行字体下载单元测试
import { describe, expect, it } from "vitest";
import { fetchFontBuffers } from "./font-load";

function mockFetcher(ok: boolean, status = 200) {
  return async (url: string) => ({
    ok,
    status,
    arrayBuffer: async () => new TextEncoder().encode(`buf:${url}`).buffer as ArrayBuffer,
  });
}

describe("fetchFontBuffers", () => {
  it("并行下载全部字体，结果与 urls 同序", async () => {
    const called: string[] = [];
    const fetcher = async (url: string) => {
      called.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(`buf:${url}`).buffer as ArrayBuffer,
      };
    };
    const urls = ["/a.otf", "/b.otf", "/c.ttf"];
    const bufs = await fetchFontBuffers(urls, fetcher);
    expect(bufs.map((b) => new TextDecoder().decode(b))).toEqual([
      "buf:/a.otf",
      "buf:/b.otf",
      "buf:/c.ttf",
    ]);
    // 并发发起：全部 URL 在首个 await 返回前已被请求
    expect(called).toEqual(urls);
  });

  it("全部下载并发发起（互不等待）", async () => {
    const order: string[] = [];
    const fetcher = async (url: string) => {
      order.push(`start:${url}`);
      await new Promise((r) => setTimeout(r, url.includes("slow") ? 20 : 0));
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    await fetchFontBuffers(["/slow.otf", "/fast.otf"], fetcher);
    // 若串行，start:/fast.otf 会等 slow 完成才出现
    expect(order[1]).toBe("start:/fast.otf");
  });

  it("任一失败则整体失败并带 URL 与状态码", async () => {
    const fetcher = async (url: string) =>
      url.includes("bad")
        ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(fetchFontBuffers(["/ok.otf", "/bad.otf"], fetcher)).rejects.toThrow(
      "字体加载失败: /bad.otf (404)",
    );
  });

  it("空列表直接返回空数组", async () => {
    const bufs = await fetchFontBuffers([], mockFetcher(true));
    expect(bufs).toEqual([]);
  });
});
