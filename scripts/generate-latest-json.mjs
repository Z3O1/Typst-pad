#!/usr/bin/env node
// 生成 Tauri 更新清单 latest.json（**静态 JSON 格式**），供 release.yml 与安装包一起发布。
//
// 为什么要自己生成：客户端（tauri-plugin-updater）拿到的是一份写死格式的清单——
//   { version, notes?, pub_date?, platforms: { "<target>": { url, signature } } }
// Tauri CLI 只产出安装包和它们的 .sig 签名，**不会**生成这份清单（那是 tauri-action 的活）；
// 本仓库的发布流程是"自己 checkout + 自己构建 + softprops 发 Release"，所以清单也自己生成，
// 免得为了一个 JSON 引进 tauri-action 并改掉整套发布逻辑。
//
// 客户端通过 tauri.conf.json 的 plugins.updater.endpoints 取它，默认是
// https://github.com/<repo>/releases/latest/download/latest.json —— 即"**最新一个已发布**
// Release 的资产"，所以草稿（draft）Release 的清单客户端拿不到，必须 Publish 之后才生效。
//
// 用法：
//   node scripts/generate-latest-json.mjs --tag v0.8.0 --out latest.json
//   node scripts/generate-latest-json.mjs --target windows-x86_64 --notes "手写说明"
//
// 本文件带 JSDoc 类型注解：它被 src/lib/update-manifest.test.ts 直接 import，
// 因此会进入 svelte-check 的检查范围（tsconfig 开了 checkJs），注解不是装饰而是编译门槛。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 默认仓库（客户端端点与下载 URL 都基于它） */
export const DEFAULT_REPO = "Z3O1/Typst-pad";
/** Tauri 打包产物目录（相对于仓库根） */
export const DEFAULT_BUNDLE_DIR = "src-tauri/target/release/bundle";
/** 版本号来源（tauri.conf.json，发版纪律要求三处一致） */
export const DEFAULT_CONF = "src-tauri/tauri.conf.json";

/**
 * node 的 platform/arch → Tauri 更新清单里的平台键。
 * 只有 Windows x64 是当前 CI 真正在打的（release.yml 跑在 windows-latest），
 * 其余键按 Tauri 的命名规范一并支持，方便将来补平台时不用改客户端。
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function updaterTarget(platform = process.platform, arch = process.arch) {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : null;
  const cpu =
    arch === "x64"
      ? "x86_64"
      : arch === "arm64"
        ? "aarch64"
        : arch === "ia32"
          ? "i686"
          : arch === "arm"
            ? "armv7"
            : null;
  if (!os || !cpu) {
    throw new Error(`无法把平台 ${platform}/${arch} 映射成 Tauri 更新目标名`);
  }
  return `${os}-${cpu}`;
}

/**
 * 是否是合法的三段式 semver（可带预发布/构建后缀）。
 * 客户端用 semver 比较版本，格式错了会直接判定"没有更新"——所以发版前就必须卡住。
 * @param {unknown} version
 * @returns {boolean}
 */
export function isSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(version ?? ""));
}

/**
 * 安装包的公开下载地址（GitHub Release 资产）
 * @param {string} repo
 * @param {string} tag
 * @param {string} assetName
 * @returns {string}
 */
export function downloadUrl(repo, tag, assetName) {
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
}

/**
 * 从打包目录的候选文件名里挑出"作为更新包发布"的那一个。
 * 优先 NSIS 的 `*-setup.exe`：Windows 上 updater 默认走 NSIS 安装器
 * （`plugins.updater.windows.installMode`）；MSI 只是备用（静默安装要管理员权限，不适合自动更新）。
 * @param {string[]} fileNames
 * @returns {string | null}
 */
export function pickUpdaterArtifact(fileNames) {
  const names = fileNames.filter((name) => !name.endsWith(".sig"));
  const nsis = names.filter((name) => /-setup\.exe$/i.test(name)).sort();
  if (nsis.length > 0) return nsis[0];
  const msi = names.filter((name) => /\.msi$/i.test(name)).sort();
  return msi[0] ?? null;
}

/**
 * @typedef {object} ManifestInput
 * @property {string} version 版本号（三段式 semver，不含 v 前缀）
 * @property {string} tag Release tag（如 v0.8.0），用于拼下载 URL
 * @property {string} assetName 安装包文件名
 * @property {string} signature .sig 文件内容
 * @property {string} [notes] 更新说明
 * @property {string} [pubDate] 发布时间（默认当前时间）
 * @property {string} [repo] 仓库（默认 Z3O1/Typst-pad）
 * @property {string} [target] 平台键（默认按当前运行平台推断）
 */

/**
 * 组装清单对象。缺签名 / 版本号非法一律抛错——宁可让发版失败，也别发出客户端装不上的更新。
 * @param {ManifestInput} input
 * @returns {{ version: string, notes: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }}
 */
export function buildManifest({
  version,
  tag,
  assetName,
  signature,
  notes = "",
  pubDate,
  repo = DEFAULT_REPO,
  target,
}) {
  if (!isSemver(version)) throw new Error(`版本号不是三段式 semver：${version}`);
  if (!tag) throw new Error("缺少 tag（安装包下载 URL 要用它）");
  if (!assetName) throw new Error("缺少安装包文件名");
  const sig = String(signature ?? "").trim();
  if (sig === "") {
    throw new Error(
      "缺少安装包签名（.sig 为空）：构建时没有设置 TAURI_SIGNING_PRIVATE_KEY，" +
        "而没有签名的更新包客户端会拒绝安装",
    );
  }
  return {
    version,
    notes,
    // 客户端用 OffsetDateTime 解析，ISO-8601（带时区）即可
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      [target ?? updaterTarget()]: {
        signature: sig,
        url: downloadUrl(repo, tag, assetName),
      },
    },
  };
}

/**
 * 从 CHANGELOG.md 里取某个版本的正文（不含 `## [x] - date` 标题行）。
 * 取不到就返回空串——更新说明是锦上添花，不能因为它让发版失败。
 * @param {string} markdown
 * @param {string} version
 * @returns {string}
 */
export function extractChangelogSection(markdown, version) {
  if (typeof markdown !== "string" || markdown === "") return "";
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s*\\[?${escaped}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/**
 * 读取 tauri.conf.json 的 version（默认版本号来源）
 * @param {string} confPath
 * @returns {string}
 */
export function readConfVersion(confPath) {
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  if (typeof conf.version !== "string") throw new Error(`${confPath} 里没有 version 字段`);
  return conf.version;
}

/**
 * 收集打包目录里可发布的安装包（nsis / msi 两个子目录，跳过 .sig）
 * @param {string} bundleDir
 * @returns {Array<{ dir: string, name: string }>}
 */
function collectArtifacts(bundleDir) {
  /** @type {Array<{ dir: string, name: string }>} */
  const found = [];
  for (const sub of ["nsis", "msi"]) {
    const dir = join(bundleDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".sig")) continue;
      found.push({ dir, name });
    }
  }
  return found;
}

/**
 * `--key value` / `--flag` 形式的极简参数解析（CI 里传的都是字符串）
 * @param {string[]} argv
 * @returns {Record<string, string | true>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * 参数值转字符串（`--flag` 形式得到 true，按"未提供"处理）
 * @param {string | true | undefined} value
 * @returns {string | undefined}
 */
function asString(value) {
  return typeof value === "string" ? value : undefined;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundleDir = asString(args.bundle) ?? DEFAULT_BUNDLE_DIR;
  const version = asString(args.version) ?? readConfVersion(asString(args.conf) ?? DEFAULT_CONF);
  const tag = asString(args.tag) ?? `v${version}`;
  const repo = asString(args.repo) ?? DEFAULT_REPO;
  const target = asString(args.target) ?? updaterTarget();

  const artifacts = collectArtifacts(bundleDir);
  const assetName = pickUpdaterArtifact(artifacts.map((a) => a.name));
  if (!assetName) {
    throw new Error(
      `在 ${bundleDir} 里没找到安装包（应有 nsis/*-setup.exe）。` +
        "确认这是 `tauri build` 的产物，并且 bundle.createUpdaterArtifacts 为 true。",
    );
  }
  const artifact = artifacts.find((a) => a.name === assetName);
  if (!artifact) throw new Error(`内部错误：找不到 ${assetName} 所在目录`);
  const sigPath = join(artifact.dir, `${assetName}.sig`);
  if (!existsSync(sigPath)) {
    throw new Error(
      `缺少签名文件 ${sigPath}：确认构建时设置了 TAURI_SIGNING_PRIVATE_KEY（打包会为每个安装包生成 .sig）`,
    );
  }
  const signature = readFileSync(sigPath, "utf8");

  let notes = "";
  const notesArg = asString(args.notes);
  const notesFile = asString(args["notes-file"]);
  if (notesArg !== undefined) {
    notes = notesArg;
  } else if (notesFile !== undefined) {
    notes = readFileSync(notesFile, "utf8").trim();
  } else if (existsSync("CHANGELOG.md")) {
    // 默认从 CHANGELOG 取该版本的正文：更新弹窗里直接显示"这版改了什么"
    notes = extractChangelogSection(readFileSync("CHANGELOG.md", "utf8"), version);
  }

  const manifest = buildManifest({
    version,
    tag,
    assetName,
    signature,
    notes,
    repo,
    target,
    pubDate: asString(args["pub-date"]),
  });

  const out = asString(args.out) ?? "latest.json";
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `[latest-json] ${out} ← ${assetName}（${target}，版本 ${version}，tag ${tag}，说明 ${
      notes ? `${notes.split("\n").length} 行` : "空"
    }）`,
  );
}

// 仅在被直接执行时跑 CLI（被单测 import 时不执行）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[latest-json] 生成失败：${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
