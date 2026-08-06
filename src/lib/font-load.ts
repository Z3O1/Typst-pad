// 启动字体加载：并行下载全部字体字节（互不依赖，可一次性并发发起）。
// 独立成模块便于单测（fetcher 可注入）；下载时延可隐藏在 wasm 实例化期间。

export type FontFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** 并行下载全部字体字节，返回与 urls 同序的字节数组；任一失败即整体失败 */
export async function fetchFontBuffers(
  urls: string[],
  fetcher: FontFetcher = fetch,
): Promise<Uint8Array[]> {
  return Promise.all(
    urls.map(async (url) => {
      const res = await fetcher(url);
      if (!res.ok) {
        throw new Error(`字体加载失败: ${url} (${res.status})`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
}
