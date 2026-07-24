/** News ingestion — port of ingest/news.py.
 *
 * Default source is Google News RSS (per-subject, quoted-name query). Users can
 * extend coverage with custom sources:
 *   - "domain": e.g. ft.com -> `"<name>" site:ft.com` queries
 *   - "rss": a full feed URL, parsed once then keyword-matched to your subjects
 *
 * Everything is deduplicated through the store, so only genuinely new items surface.
 */

import { XMLParser } from "fast-xml-parser";

import type { NewsItem, Subject } from "../models.ts";
import { isTheme, subjectKey } from "../models.ts";
import type { HttpClient } from "../platform.ts";
import type { Store } from "../store/db.ts";

export const GOOGLE_NEWS_RSS =
  "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en";

/** Yahoo's headline RSS — the stable stand-in for yfinance's `.news`. */
export const YAHOO_RSS =
  "https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US";

export interface NewsSource { type: string; value: string; name?: string }

/** dedup_key — mirrors models.NewsItem.dedup_key: url or title, trimmed+lowercased. */
export const dedupKey = (item: { url: string; title: string }): string =>
  (item.url || item.title).trim().toLowerCase();

/** Python's urllib.parse.quote_plus. */
export function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Mirrors news.py _query_for(): quote a company name for precision, leave
 * themes unquoted for broader matching, and append a site: filter if given. */
export function queryFor(subj: Subject, site: string | null): string {
  const base = subj.name || subj.ticker;
  let q = isTheme(subj) ? base : `"${base}"`;
  if (site) q += ` site:${site}`;
  return quotePlus(q);
}

export const googleNewsUrl = (subj: Subject, site: string | null): string =>
  GOOGLE_NEWS_RSS.replace("{query}", queryFor(subj, site));

// ------------------------------------------------------------------ RSS parsing
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  processEntities: true,
});

export interface RssEntry {
  title: string;
  link: string;
  source: string;
  published: string | null;
  summary: string;
}

const text = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["#text"] ?? "");
  }
  return String(v);
};

/** Parse RSS 2.0 / Atom into a normalised entry list. */
export function parseFeed(xml: string): RssEntry[] {
  let doc: any;
  try { doc = parser.parse(xml); } catch { return []; }
  const chan = doc?.rss?.channel ?? doc?.feed ?? null;
  if (!chan) return [];
  const rawItems = chan.item ?? chan.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const out: RssEntry[] = [];
  for (const it of items) {
    if (!it) continue;
    let link = "";
    if (typeof it.link === "string") link = it.link;
    else if (Array.isArray(it.link)) link = it.link[0]?.["@_href"] ?? text(it.link[0]);
    else if (it.link) link = it.link["@_href"] ?? text(it.link);
    const published = it.pubDate ?? it.published ?? it.updated ?? null;
    out.push({
      title: text(it.title).trim(),
      link: String(link).trim(),
      source: text(it.source).trim(),
      published: published ? String(published) : null,
      summary: String(text(it.description) || text(it.summary) || "").slice(0, 500),
    });
  }
  return out;
}

/** RFC-822 / ISO date -> epoch ms, or null. */
export function parseDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// ------------------------------------------------------------------ fetching
function toItems(
  subj: Subject, entries: RssEntry[], cutoffMs: number, fallbackSource: string,
  limit: number, requireTitle = false,
): NewsItem[] {
  const out: NewsItem[] = [];
  for (const e of entries.slice(0, limit)) {
    const pub = parseDate(e.published);
    if (pub !== null && pub < cutoffMs) continue;
    if (requireTitle && !e.title) continue; // matches the ticker-news path in news.py
    out.push({
      ticker: subjectKey(subj),
      title: e.title,
      url: e.link,
      source: e.source || fallbackSource,
      summary: e.summary,
    });
  }
  return out;
}

/** Return { subjectKey: [newly-seen items] } within the lookback window. */
export async function fetchNewsForSubjects(
  subjects: Subject[],
  lookbackDays: number,
  http: HttpClient,
  store: Store,
  sources: NewsSource[] = [],
): Promise<Record<string, NewsItem[]>> {
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  const domains = sources.filter((s) => s.type === "domain" && s.value).map((s) => s.value);
  const feeds = sources.filter((s) => s.type === "rss" && s.value);
  const results: Record<string, NewsItem[]> = {};

  const push = async (key: string, items: NewsItem[]) => {
    for (const it of items) {
      const isNew = await store.saveNews({
        dedup_key: dedupKey(it), ticker: it.ticker, title: it.title, url: it.url,
        source: it.source, published: null, summary: it.summary,
      });
      if (isNew) (results[key] ??= []).push(it);
    }
  };

  for (const subj of subjects) {
    const items: NewsItem[] = [];
    for (const site of [null, ...domains]) {
      const xml = await http.getText(googleNewsUrl(subj, site));
      if (xml) items.push(...toItems(subj, parseFeed(xml), cutoff, site ?? "Google News", 10));
    }
    if (subj.ticker) {
      const xml = await http.getText(YAHOO_RSS.replace("{ticker}", encodeURIComponent(subj.ticker)));
      if (xml) items.push(...toItems(subj, parseFeed(xml), cutoff, "Yahoo Finance", 10, true));
    }
    await push(subjectKey(subj), items);
  }

  // Custom feeds are general: fetch each once and attribute by keyword match.
  for (const feed of feeds) {
    const xml = await http.getText(feed.value);
    if (!xml) continue;
    const entries = parseFeed(xml).slice(0, 60);
    const terms = subjects.map((s) => ({
      key: subjectKey(s),
      keys: [s.ticker, s.name].filter(Boolean).map((k) => k.toLowerCase()),
    }));
    for (const e of entries) {
      const pub = parseDate(e.published);
      if (pub !== null && pub < cutoff) continue;
      const hay = `${e.title} ${e.summary}`.toLowerCase();
      for (const t of terms) {
        if (t.keys.some((k) => k.length >= 3 && hay.includes(k))) {
          await push(t.key, [{
            ticker: t.key, title: e.title, url: e.link,
            source: feed.name || feed.value, summary: e.summary,
          }]);
          break; // first match wins, as in the Python version
        }
      }
    }
  }

  return results;
}
