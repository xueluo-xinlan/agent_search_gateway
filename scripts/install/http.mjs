/**
 * 安装器公共 HTTP 工具。
 *
 * Node 内置 fetch 不读取 HTTPS_PROXY；这里在检测到代理时优先用 curl/wget，
 * 否则先 fetch，失败再回退。所有下载只允许 https，先写临时文件再原子 rename。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

export function proxyEnvName() {
  for (const key of PROXY_KEYS) {
    if ((process.env[key] || '').trim()) return key;
  }
  return null;
}

export function assertHttps(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`安全限制：只允许 https，收到 ${url}`);
  }
  return parsed;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
    } catch (error) {
      resolve({ code: null, stderr: error.message });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.once('error', (error) => resolve({ code: null, stderr: error.message }));
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

/** 合并默认 UA、调用方自定义头与 GitHub token；Authorization 只发给 GitHub API。 */
export function buildHeaders(url, token, extra = {}) {
  const headers = { 'User-Agent': 'agent-search-gateway-installer', ...extra };
  const isApi = new URL(url).hostname === 'api.github.com';
  // Release 资产通常是 github.com / objects.githubusercontent.com 的地址，
  // 不能把 API token 跟着浏览器下载地址发过去。
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization' && !isApi) delete headers[key];
  }
  const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (token && isApi && !hasAuthorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function curlHeaderArgs(headers) {
  return Object.entries(headers).flatMap(([key, value]) => ['-H', `${key}: ${value}`]);
}

async function downloadWithCurl(url, dest, headers, logger) {
  const result = await run('curl', [
    '-fsSL',
    '--retry', '2',
    '--connect-timeout', '20',
    '--max-time', '600',
    '--proto', '=https',
    ...curlHeaderArgs(headers),
    '-o', dest,
    url,
  ]);
  if (result.code === 0) {
    logger?.(`已通过 curl 下载: ${path.basename(dest)}`);
    return null;
  }
  return `curl: ${result.stderr.trim() || `退出码 ${result.code}`}`;
}

async function downloadWithWget(url, dest, headers, logger) {
  const headerArgs = Object.entries(headers).map(([key, value]) => `--header=${key}: ${value}`);
  const result = await run('wget', [
    '-nv',
    '--https-only',
    '--max-redirect=5',
    ...headerArgs,
    '-O', dest,
    url,
  ]);
  if (result.code === 0) {
    logger?.(`已通过 wget 下载: ${path.basename(dest)}`);
    return null;
  }
  return `wget: ${result.stderr.trim() || `退出码 ${result.code}`}`;
}

async function downloadWithFetch(url, dest, headers, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok) return `HTTP ${res.status}`;
    if (!res.body) return '响应没有内容';
    assertHttps(res.url || url);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    logger?.(`已通过 fetch 下载: ${path.basename(dest)}`);
    return null;
  } catch (error) {
    return `fetch: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

/** 下载文件到 dest；失败抛错并清理临时文件。headers 用于 GitHub API 等需要自定义请求头的场景。 */
export async function download(url, dest, { token = '', logger, headers = {} } = {}) {
  assertHttps(url);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  const requestHeaders = buildHeaders(url, token, headers);
  const proxy = proxyEnvName();
  const attempts = proxy
    ? [downloadWithCurl, downloadWithWget, downloadWithFetch]
    : [downloadWithFetch, downloadWithCurl, downloadWithWget];

  let reason = '';
  try {
    for (const attempt of attempts) {
      try {
        const failure = await attempt(url, tmp, requestHeaders, logger);
        if (!failure) {
          const stat = await fs.stat(tmp);
          if (stat.size === 0) throw new Error('下载内容为空');
          await fs.rename(tmp, dest);
          return dest;
        }
        reason = failure;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    const hint = proxy
      ? `已检测到代理变量 ${proxy}，请检查代理是否可用。`
      : '若在代理环境，请设置 HTTPS_PROXY（或 https_proxy）后重试，例如 HTTPS_PROXY=http://127.0.0.1:7897。';
    throw new Error(`下载失败: ${url}\n${reason ? `原因: ${reason}\n` : ''}${hint}`);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function fetchText(url, { token = '', logger, headers = {} } = {}) {
  const tmp = path.join(process.cwd(), `.asg-fetch-${process.pid}-${Date.now()}`);
  try {
    await download(url, tmp, { token, logger, headers });
    return await fs.readFile(tmp, 'utf8');
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, options));
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifySha256(file, expected, label = path.basename(file)) {
  if (!expected) return;
  const actual = await sha256File(file);
  if (actual !== expected.toLowerCase()) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw new Error(`${label} SHA256 校验失败\n  期望: ${expected}\n  实际: ${actual}`);
  }
}
