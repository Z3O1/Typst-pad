#!/usr/bin/env node
// 发版后的**匿名验收**：不登录、不带任何 GitHub 凭据，完全模拟一个普通用户，
// 验三件事（顺序就是"坏了最该先看哪个"的排序）：
//   ① `latest.json` 能不能匿名取到（**自动更新的硬前提**：草稿 Release 或私有仓库一律 404）；
//   ② 清单里的 version 是不是刚发的那个、安装包能不能下载（字节数）；
//   ③ 安装包的 minisign 签名能不能用 `tauri.conf.json` 里的公钥验过（CI 换钥匙/签名不匹配的兜底）。
//
// 用法：
//   node scripts/verify-release.mjs                 # 默认验当前 package.json 里的版本
//   node scripts/verify-release.mjs 0.8.0           # 指定版本
//   node scripts/verify-release.mjs 0.8.0 --keep    # 下载的安装包留在 .browser-check/（不删）
//
// **踩过的坑（别再重写这段解析）**：`latest.json` 里 `signature` 字段是"base64 文本"，解开是
// minisign 的 5 行（untrusted comment / 主签名 / trusted comment / 它的签名 / 空行）——
//   · **主签名**那行 base64 解出来是 **74 字节**：`2 字节 alg（"ED"）+ 8 字节 keyid + 64 字节签名`；
//   · trusted comment 的签名是**纯 64 字节、没有头**，`.pop()` 拿到的正是它 ——
//     于是 `alg` 会解出乱码、keyid 也不对，看起来像"验签失败"，其实是自己解析错了（2026-09-16 犯过）。
//   所以这里**按"哪一行解出来是 74 字节"来挑**，不靠行号。
//   · alg `ED` = minisign 的 prehashed 模式：先 BLAKE2b-512，再对摘要做 ed25519 验签。
//   · 公钥取 `plugins.updater.pubkey`（单行 base64）解出来的**第二行**，去掉 10 字节头（2 字节 alg + 8 字节 keyid）
//     得到 32 字节原始公钥，前面补 SPKI 前缀 `302a300506032b6570032100` 才能交给 node:crypto。

import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "Z3O1/Typst-pad";
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const wantVersion = args.find((a) => !a.startsWith("--"));
const version =
  wantVersion ??
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const manifestUrl = `https://github.com/${REPO}/releases/latest/download/latest.json`;
const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};

say(`匿名验收 ${REPO} v${version}`);

// ① 清单匿名可达
const res = await fetch(manifestUrl, { redirect: "follow" });
if (!res.ok) {
  say(`❌ latest.json HTTP ${res.status} —— 自动更新拿不到清单。`);
  say(
    `   先查草稿：gh release view v${version} --repo ${REPO} --json isDraft（草稿资产对匿名不可见）`,
  );
  process.exit(1);
}
const manifest = await res.json();
say(`✅ latest.json HTTP 200`);

// ② 版本号 + 安装包
say(
  manifest.version === version
    ? `✅ version ${manifest.version}`
    : `❌ version 是 ${manifest.version}，期望 ${version}`,
);
const platform = manifest.platforms?.["windows-x86_64"];
if (!platform) {
  say(`❌ 清单里没有 windows-x86_64 平台`);
  process.exit(1);
}
const installerUrl = platform.url;
const installerName = installerUrl.split("/").pop();
const dir = mkdtempSync(join(tmpdir(), "verify-release-"));
const installerPath = join(
  keep ? new URL("../.browser-check", import.meta.url).pathname : dir,
  installerName,
);
const instRes = await fetch(installerUrl, { redirect: "follow" });
if (!instRes.ok) {
  say(`❌ 安装包 HTTP ${instRes.status}（${installerName}）`);
  process.exit(1);
}
const bytes = Buffer.from(await instRes.arrayBuffer());
writeFileSync(installerPath, bytes);
say(`✅ 安装包 ${installerName} HTTP 200，${bytes.length} 字节`);

// ③ 签名验签
const sigText = Buffer.from(platform.signature, "base64").toString("utf8");
let blob = null;
for (const line of sigText
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)) {
  const decoded = Buffer.from(line, "base64");
  if (decoded.length === 74) {
    blob = decoded;
    break;
  }
}
if (!blob) {
  say(`❌ 清单里没找到 74 字节的主签名块（minisign 格式变了？）`);
  process.exit(1);
}
const alg = blob.subarray(0, 2).toString("ascii");
const keyid = blob.subarray(2, 10).toString("hex");
const signature = blob.subarray(10);
const pubkeyB64 = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).plugins.updater.pubkey;
const pubkeyRaw = Buffer.from(
  Buffer.from(pubkeyB64, "base64")
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[1],
  "base64",
).subarray(10, 42);
const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubkeyRaw]),
  format: "der",
  type: "spki",
});
const digest = createHash("blake2b512").update(bytes).digest();
const ok = alg === "ED" && verify(null, digest, key, signature);
say(`${ok ? "✅" : "❌"} 验签${ok ? "通过" : "失败"}（alg ${alg}、keyid ${keyid}）`);
if (!keep) rmSync(dir, { recursive: true, force: true });
else say(`   安装包留在 ${installerPath}`);

process.exit(ok && manifest.version === version ? 0 : 1);
