/**
 * 网络层：下载、GitHub 发布查询、解压、校验。
 *
 * 为什么不用 Node 的 fetch：
 *   1. 网络出口可能是代理（HTTPS_PROXY），而 Node 的 undici 默认**不读**这两个环境变量。
 *      自己实现 CONNECT 隧道要多写 80 行且容易在 TLS 上翻车，不如直接用系统 curl（Win10+ 自带）。
 *      注意这里**只读环境变量、不写死任何地址**：分发给谁就用谁自己的网络配置。
 *   2. curl 自带断点续传（-C -）、大小上限（--max-filesize）、重试，这三样本插件都需要。
 *
 * 三条诚实原则：
 *   - 每个下载都必须留下 **sha256 + 来源 URL + 时间**，写进 provenance，可复核。
 *   - 下载完必须**回读大小**；curl 退出码 0 不代表文件完整（代理断流时会得到截断文件）。
 *   - 解压后必须**确认目标文件真的存在**，而不是"解压命令成功了"。
 */
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';

import { join } from './config.js';
import { runOnce } from './execution.js';

/** 代理：环境变量优先，其次显式传入。返回 '' 表示直连。 */
export function proxyOf(explicit = '') {
  if (explicit) return explicit;
  const env = process.env;
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
}

const probeCache = new Map();

function tcpAlive(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let done = false;
    const sock = connect({ host, port });
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
  });
}

/**
 * 决定这一次走不走代理 —— 关键在**先探活**。
 *
 * 为什么必须探：代理地址是「部署环境给的」，而它是会变的（端口换了、进程退了、
 * 换到透明代理的机器上就压根不需要 --proxy）。配置里留着一个已经死掉的端口，
 * 会让每一次网络操作都在 2 秒后失败，而且报错看起来像是「对方站点连不上」。
 * 所以：探不到就直连，并把「降级了」这件事如实报给调用方，而不是静默。
 *
 * @returns {{proxy: string, mode: 'direct'|'proxy'|'direct-fallback', configured: string}}
 */
export async function resolveProxy(explicit = '') {
  const configured = proxyOf(explicit);
  if (!configured) return { proxy: '', mode: 'direct', configured: '' };

  if (!probeCache.has(configured)) {
    let host = '';
    let port = 0;
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(configured) ? configured : `http://${configured}`);
      host = u.hostname;
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch { host = ''; }
    probeCache.set(configured, host ? await tcpAlive(host, port) : false);
  }
  const alive = probeCache.get(configured);
  return alive
    ? { proxy: configured, mode: 'proxy', configured }
    : { proxy: '', mode: 'direct-fallback', configured };
}

/** proxy 参数这里已经是「最终决定」的地址（'' = 直连），不再二次解析。 */
function curlArgs({ url, extra = [], proxy = '' }) {
  return [
    '-sS', '-L', '--retry', '3', '--retry-delay', '2',
    '--connect-timeout', '20',
    ...(proxy ? ['--proxy', proxy] : []),
    ...extra,
    url,
  ];
}

/** GET 一段文本（用于 GitHub API / 小文件） */
export async function httpText({ url, proxy = '', timeoutMs = 30_000, headers = {} }) {
  const hdrs = Object.entries({
    'User-Agent': 'dsh-train-pipeline',
    Accept: 'application/vnd.github+json',
    ...headers,
  }).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  const { proxy: px } = await resolveProxy(proxy);
  const r = await runOnce({
    cmd: 'curl',
    args: curlArgs({ url, proxy: px, extra: [...hdrs, '--max-time', String(Math.ceil(timeoutMs / 1000))] }),
    timeoutMs: timeoutMs + 5000,
  });
  return { ok: r.ok, text: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
}

export async function httpJson({ url, proxy = '', timeoutMs = 30_000 }) {
  const r = await httpText({ url, proxy, timeoutMs });
  if (!r.ok) return { ok: false, error: r.stderr?.slice(0, 400) || `HTTP 失败（exit=${r.exitCode}）`, status: r.exitCode };
  try {
    return { ok: true, json: JSON.parse(r.text) };
  } catch {
    return { ok: false, error: '响应不是 JSON（可能被代理拦截或触发限流）', raw: r.text.slice(0, 300) };
  }
}

export function sha256File(path) {
  return new Promise((resolve) => {
    try {
      if (!existsSync(path)) return resolve('');
      const h = createHash('sha256');
      const s = createReadStream(path);
      s.on('data', (b) => h.update(b));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', () => resolve(''));
    } catch { resolve(''); }
  });
}

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
};

export { fmtBytes };

/**
 * 下载文件。
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.dest          最终落盘路径
 * @param {number} [o.maxBytes]    上限（curl --max-filesize，超限直接失败而不是慢慢撑爆磁盘）
 * @param {boolean} [o.resume]     断点续传
 * @param {string} [o.sha256]      期望摘要，不符即判失败
 */
export async function download({
  url, dest, maxBytes = 2 * 1024 ** 3, resume = true, sha256 = '', proxy = '', timeoutMs = 1_800_000, headers = {},
}) {
  mkdirSync(dirname(dest), { recursive: true });
  const hdrs = Object.entries(headers ?? {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  const extra = [
    '-o', dest,
    '--max-filesize', String(Math.max(1, Math.floor(maxBytes))),
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-w', '%{http_code}|%{size_download}|%{speed_download}|%{content_type}',
    ...hdrs,
  ];
  if (resume && existsSync(dest) && statSync(dest).size > 0) extra.unshift('-C', '-');

  const px = await resolveProxy(proxy);
  const r = await runOnce({ cmd: 'curl', args: curlArgs({ url, extra, proxy: px.proxy }), timeoutMs: timeoutMs + 10_000 });
  const [code, size, speed, ctype] = String(r.stdout || '').trim().split('|');
  const httpCode = Number(code) || 0;
  let sizeBytes = 0;
  try { sizeBytes = existsSync(dest) ? statSync(dest).size : 0; } catch { /* ignore */ }

  const base = {
    url, dest, httpCode, sizeBytes, sizeText: fmtBytes(sizeBytes),
    contentType: ctype || '',
    proxyMode: px.mode,
    proxyConfigured: px.mode === 'direct-fallback' ? px.configured : '',
    speedKbps: Number(speed) ? Math.round(Number(speed) / 1024) : 0,
    exitCode: r.exitCode,
  };

  // 退出码 33 = 服务端不支持续传；此时清掉半截文件重下一次
  if (r.exitCode === 33) {
    try { unlinkSync(dest); } catch { /* ignore */ }
    return { ...(await download({ url, dest, maxBytes, resume: false, sha256, proxy, timeoutMs })), retried: true };
  }

  // 416 = 本地文件已经不小于远端（重复下载同一个 URL 时会走到这里）。
  // 这**不代表失败**：文件先前就下完了，直接当"已存在"处理并照样算摘要。
  if (httpCode === 416 && sizeBytes > 0) {
    const digest = await sha256File(dest);
    if (sha256 && digest.toLowerCase() !== String(sha256).toLowerCase()) {
      try { unlinkSync(dest); } catch { /* ignore */ }
      return { ...(await download({ url, dest, maxBytes, resume: false, sha256, proxy, timeoutMs })), retried: true };
    }
    return { ok: true, ...base, httpCode: 416, sha256: digest, cached: true };
  }
  if (!r.ok || httpCode >= 400 || sizeBytes === 0) {
    return { ok: false, ...base, error: r.exitCode === 63 ? `超过大小上限 ${fmtBytes(maxBytes)}` : (r.stderr?.slice(0, 400) || `HTTP ${httpCode || '(无响应)'}`) };
  }
  const digest = await sha256File(dest);
  if (sha256 && digest.toLowerCase() !== String(sha256).toLowerCase()) {
    return { ok: false, ...base, sha256: digest, error: 'sha256 不匹配（下载损坏或被替换）' };
  }
  return { ok: true, ...base, sha256: digest };
}

/** 解压 zip：优先系统 bsdtar（Win10+ 自带，支持 zip），退回 PowerShell Expand-Archive。
 *  ⚠️ 不能用 PATH 里的 `tar`：Git for Windows 带的是 GNU tar，它**不认 zip**（实测报
 *  "This does not look like a tar archive"）。所以这里显式用 System32 的 bsdtar。 */
export async function unzip({ zipPath, destDir }) {
  if (!existsSync(zipPath)) return { ok: false, error: `文件不存在: ${zipPath}` };
  mkdirSync(destDir, { recursive: true });

  const bsdtar = existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';
  const t = await runOnce({ cmd: bsdtar, args: ['-xf', zipPath, '-C', destDir], timeoutMs: 300_000 });
  if (t.ok) return { ok: true, tool: 'bsdtar' };

  const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
  const p = await runOnce({
    cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps], timeoutMs: 300_000,
  });
  if (p.ok) return { ok: true, tool: 'powershell' };
  return { ok: false, error: `解压失败: tar(${t.stderr?.slice(0, 120)}) / ps(${p.stderr?.slice(0, 160)})` };
}

/** 在目录里递归找文件名匹配的第一个文件（可选最大深度） */
export function findFile(dir, re, depth = 4) {
  if (!existsSync(dir)) return '';
  const walk = (d, lv) => {
    if (lv > depth) return '';
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return ''; }
    for (const e of entries) if (e.isFile() && re.test(e.name)) return join(d, e.name);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = walk(join(d, e.name), lv + 1);
      if (hit) return hit;
    }
    return '';
  };
  return walk(dir, 0);
}

/** 取 GitHub 仓库的发布列表（含资产）。返回 [] 表示没发布或查询失败，调用方必须自行区分。 */
export async function githubReleases({ repo, proxy = '', limit = 12, timeoutMs = 30_000 }) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = {
    'User-Agent': 'dsh-train-pipeline',
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const url = `https://api.github.com/repos/${repo}/releases?per_page=${limit}`;
  const r = await httpText({ url, proxy, timeoutMs, headers });
  try {
    const arr = JSON.parse(r.text);
    if (!r.ok || !Array.isArray(arr)) {
      return { ok: false, releases: [], error: 'GitHub 返回异常（可能被限流或代理拦截）', raw: String(r.text).slice(0, 200) };
    }
    return {
      ok: true,
      releases: arr.map((rel) => ({
        tag: rel.tag_name || rel.name || '',
        name: rel.name || rel.tag_name || '',
        prerelease: !!rel.prerelease,
        published: rel.published_at || '',
        htmlUrl: rel.html_url || '',
        assets: (rel.assets ?? []).map((a) => ({
          name: a.name, size: a.size, url: a.browser_download_url, downloads: a.download_count ?? 0,
        })),
      })),
    };
  } catch {
    return { ok: false, releases: [], error: '无法解析 GitHub 响应（网络或代理问题）', raw: String(r.text).slice(0, 200) };
  }
}

/** 写一条 provenance（可复核的取材凭据），返回累积后的记录 */
export function recordProvenance(path, entry) {
  let all = [];
  try { all = JSON.parse(readFileSync(path, 'utf8')); } catch { all = []; }
  all = Array.isArray(all) ? all : [];
  all.push({ at: new Date().toISOString(), ...entry });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2), 'utf8');
  } catch { /* 记不上也不能阻断主流程 */ }
  return all;
}
