import domino from "@mixmark-io/domino";
import type { Logger } from "../logger.js";
import type { SearchRequest, SearxngResponse, SearxngResult } from "./searxng.js";

/**
 * 备用直连搜索引擎：当上游 SearXNG 不可达或超时时自动兜底。
 *
 * 顺序：Tavily（有 key 时） → Bing HTML → DuckDuckGo HTML
 *
 * 为什么 Bing 排在 DDG 前面：2026-11-15 实测，DDG 的两个 HTML 端
 * （html./lite.duckduckgo.com）对本站机房 IP 一律返回 **HTTP 202 挑战页**
 * （约 14KB、0 个结果节点），`res.ok` 为真但内容是壳；Bing 同期返回 200 +
 * 可解析的 `li.b_algo`。兜底的价值在于「上游挂了还能出结果」，出不了结果的兜底等于没有。
 *
 * 上游 0.3.x 删掉了这个能力，只保留 searxng。本部署保留：searxng 是单点。
 */
export interface FallbackOptions {
  /** Tavily API key；为空则跳过。 */
  tavilyApiKey?: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ACCEPT_LANG = "zh-CN,zh;q=0.9,en;q=0.8";

/**
 * Bing 的结果链接是 `https://www.bing.com/ck/a?...&u=a1<base64url>` 跳转壳。
 * 不还原的话，每条结果都指向 bing.com 的跳转地址，点开还要多一跳。
 */
function decodeBingUrl(href: string): string {
  const m = href.match(/[?&]u=a1([A-Za-z0-9_\-=]+)/);
  if (m) {
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      if (decoded.startsWith("http")) return decoded;
    } catch {
      /* 解不开就用原链接 */
    }
  }
  return href;
}

async function searchTavily(
  req: SearchRequest,
  apiKey: string,
  logger: Logger,
): Promise<SearxngResponse | undefined> {
  try {
    logger.info(`兜底：尝试 Tavily API 检索 "${req.query}"`);
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: req.query,
        max_results: 10,
        search_depth: "basic",
        include_answer: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn(`Tavily 兜底失败 (HTTP ${res.status})`);
      return undefined;
    }
    const data = (await res.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
    };
    const results: SearxngResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
      engine: "tavily",
      score: r.score ?? 0.9,
    }));
    if (results.length === 0) return undefined;
    return {
      query: req.query,
      results,
      answers: data.answer ? [{ answer: data.answer }] : [],
      suggestions: [],
    };
  } catch (err) {
    logger.warn(`Tavily 兜底异常: ${String(err)}`);
    return undefined;
  }
}

async function searchBing(req: SearchRequest, logger: Logger): Promise<SearxngResponse | undefined> {
  // 实测 Bing 会偶发返回不含 li.b_algo 的变体页面（同一查询间隔几秒重试即可恢复），
  // 所以这里重试两次；只在两次都空时才判失败，避免把偶发当常态。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      logger.info(`兜底：尝试 Bing HTML 检索 "${req.query}"${attempt > 1 ? `（第 ${attempt} 次）` : ""}`);
      const url = `https://www.bing.com/search?q=${encodeURIComponent(req.query)}&count=10&setlang=zh-CN`;
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": req.language || ACCEPT_LANG },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        logger.warn(`Bing 兜底失败 (HTTP ${res.status})`);
        continue;
      }
      const html = await res.text();
      const doc = domino.createDocument(html);
      const results: SearxngResult[] = [];
      for (const el of Array.from(doc.querySelectorAll("li.b_algo"))) {
        const a = el.querySelector("h2 a");
        if (!a) continue;
        const link = decodeBingUrl(a.getAttribute("href") || "");
        if (!link.startsWith("http")) continue;
        const title = a.textContent?.trim() || "";
        const snippet = el.querySelector(".b_caption p, .b_caption")?.textContent?.trim() || "";
        if (!title) continue;
        results.push({ title, url: link, content: snippet, engine: "bing", score: 0.8 });
        if (results.length >= 10) break;
      }
      if (results.length === 0) {
        logger.warn(`Bing 兜底返回 0 条（${html.length}B，可能命中变体页面）`);
        continue;
      }
      logger.info(`Bing 兜底返回 ${results.length} 条`);
      return { query: req.query, results, answers: [], suggestions: [] };
    } catch (err) {
      logger.warn(`Bing 兜底异常: ${String(err)}`);
    }
  }
  return undefined;
}

async function searchDdg(req: SearchRequest, logger: Logger): Promise<SearxngResponse | undefined> {
  try {
    logger.info(`兜底：尝试 DuckDuckGo HTML 检索 "${req.query}"`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(req.query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": req.language || ACCEPT_LANG },
      signal: AbortSignal.timeout(12000),
    });
    // DDG 对机房 IP 返 202 挑战页：状态码看着"成功"，内容却是壳，必须看结果数
    const html = await res.text();
    if (!res.ok) {
      logger.warn(`DuckDuckGo 兜底失败 (HTTP ${res.status})`);
      return undefined;
    }
    const doc = domino.createDocument(html);
    const results: SearxngResult[] = [];
    for (const el of Array.from(doc.querySelectorAll(".result"))) {
      const cls = el.getAttribute("class") || "";
      if (cls.includes("result--ad") || el.querySelector(".badge--ad")) continue;
      const titleEl = el.querySelector(".result__title .result__a");
      if (!titleEl) continue;
      let link = titleEl.getAttribute("href") || "";
      if (link.includes("uddg=")) {
        try {
          const u = new URL(link, "https://duckduckgo.com");
          const real = u.searchParams.get("uddg");
          if (real) link = decodeURIComponent(real);
        } catch {
          /* 解析失败就用原链接 */
        }
      }
      if (link.startsWith("//")) link = "https:" + link;
      if (!link.startsWith("http")) continue;
      const title = titleEl.textContent?.trim() || "";
      const content = el.querySelector(".result__snippet")?.textContent?.trim() || "";
      if (title) results.push({ title, url: link, content, engine: "duckduckgo", score: 0.7 });
    }
    if (results.length === 0) {
      logger.warn(`DuckDuckGo 兜底返回 0 条（HTTP ${res.status}，机房 IP 常见 202 挑战页）`);
      return undefined;
    }
    return { query: req.query, results, answers: [], suggestions: [] };
  } catch (err) {
    logger.warn(`DuckDuckGo 兜底异常: ${String(err)}`);
    return undefined;
  }
}

/**
 * 依次尝试各兜底通道，第一个出结果的胜出。
 * 全部失败时抛错，由调用方按「上游失败」处理。
 */
export async function searchFallback(
  req: SearchRequest,
  opts: FallbackOptions,
  logger: Logger,
): Promise<SearxngResponse> {
  if (opts.tavilyApiKey) {
    const tavily = await searchTavily(req, opts.tavilyApiKey, logger);
    if (tavily) return tavily;
  }
  const bing = await searchBing(req, logger);
  if (bing) return bing;

  const ddg = await searchDdg(req, logger);
  if (ddg) return ddg;

  throw new Error("所有兜底通道均未返回结果（Tavily/Bing/DuckDuckGo）");
}
