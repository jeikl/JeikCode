/**
 * Cloudflare Pages Function: /api/releases
 *
 * 作用：作为 GitHub Releases 的全球边缘缓存中继。
 * 客户端只读这份 JSON（版本号和更新公告 body 在一起），不再直连 api.github.com，
 * 避免未授权接口每小时 60 次的额度。
 * 边缘分页读取公开的 /releases HTML（不走 REST API），正文来自每条 markdown-body。
 * HTML 失败时退回 releases.atom 的 <content>，两者都失败才用 REST API。
 * 全球 CDN 边缘缓存 70 秒。
 */

const GITHUB_HEADERS = {
  'User-Agent': 'JeikCode-Cloudflare-Relay',
  Accept: 'text/html,application/xhtml+xml,application/atom+xml,*/*',
};

function parseNextLink(linkHeader) {
  if (!linkHeader) return '';
  for (const part of linkHeader.split(',')) {
    if (!part.includes('rel="next"')) continue;
    const match = part.match(/<([^>]+)>/);
    if (match) return match[1];
  }
  return '';
}

function releaseAssets(tag) {
  const cleanVer = tag.replace(/^v/, '');
  const base = `https://github.com/jeikl/JeikCode/releases/download/${tag}`;
  return [
    { name: `jeikcode-${tag}-windows-x64.exe`, browser_download_url: `${base}/jeikcode-${tag}-windows-x64.exe` },
    { name: `jeikcode-${tag}-darwin-arm64`, browser_download_url: `${base}/jeikcode-${tag}-darwin-arm64` },
    { name: `jeikcode-${tag}-darwin-x64`, browser_download_url: `${base}/jeikcode-${tag}-darwin-x64` },
    { name: `jeikcode-${tag}-linux-x64`, browser_download_url: `${base}/jeikcode-${tag}-linux-x64` },
    { name: `jeikcode-${tag}-linux-arm64`, browser_download_url: `${base}/jeikcode-${tag}-linux-arm64` },
    { name: `JeikCode-Desktop-Setup-${tag}.exe`, browser_download_url: `${base}/JeikCode.Desktop_${cleanVer}_x64-setup.exe` },
    { name: `JeikCode-Desktop-${tag}.dmg`, browser_download_url: `${base}/JeikCode.Desktop_${cleanVer}_aarch64.dmg` },
    { name: `JeikCode-Desktop-x64-${tag}.dmg`, browser_download_url: `${base}/JeikCode.Desktop_${cleanVer}_x64.dmg` },
    { name: `JeikCode-Desktop-${tag}.AppImage`, browser_download_url: `${base}/JeikCode.Desktop_${cleanVer}_amd64.AppImage` },
    { name: `JeikCode-Desktop-${tag}.deb`, browser_download_url: `${base}/JeikCode.Desktop_${cleanVer}_amd64.deb` },
  ];
}

function listedRelease(tag, publishedAt, body) {
  return {
    tag_name: tag,
    prerelease: tag.includes('-'),
    published_at: publishedAt || null,
    body: body || null,
    html_url: `https://github.com/jeikl/JeikCode/releases/tag/${tag}`,
    assets: releaseAssets(tag),
  };
}

/**
 * GitHub's public releases HTML page collapses long announcements and appends
 * a "Read more" link, so scraping that page alone silently truncates the body
 * (the page text literally ends with `...`). Detect it so the caller can
 * enrich the body from Atom or the REST API.
 */
function bodyLooksTruncated(body) {
  if (typeof body !== 'string' || !body) return false;
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return (text.endsWith('...') || text.endsWith('…')) && text.length >= 500;
}

/**
 * Merge release lists by tag. A complete body always wins over a truncated
 * one; HTML/Atom assets and timestamps fill gaps instead of being discarded.
 */
function mergeReleaseLists(primary, extra) {
  const byTag = new Map(primary.map((rel) => [rel.tag_name, rel]));
  for (const rel of extra) {
    if (!rel || !rel.tag_name) continue;
    const existing = byTag.get(rel.tag_name);
    if (!existing) {
      byTag.set(rel.tag_name, rel);
      continue;
    }
    if ((!existing.body || bodyLooksTruncated(existing.body)) && rel.body && !bodyLooksTruncated(rel.body)) {
      existing.body = rel.body;
    }
    if (!existing.published_at && rel.published_at) existing.published_at = rel.published_at;
    if ((!existing.assets || existing.assets.length === 0) && rel.assets && rel.assets.length > 0) {
      existing.assets = rel.assets;
    }
    existing.prerelease = existing.prerelease || rel.prerelease;
  }
  return [...byTag.values()];
}

function extractMarkdownBody(block) {
  const marker = 'class="markdown-body';
  const startAttr = block.indexOf(marker);
  if (startAttr < 0) return null;
  const contentStart = block.indexOf('>', startAttr) + 1;
  let i = contentStart;
  let depth = 1;
  while (i < block.length && depth > 0) {
    const nextOpen = block.indexOf('<div', i);
    const nextClose = block.indexOf('</div>', i);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
    } else {
      depth -= 1;
      if (depth === 0) {
        const html = block.slice(contentStart, nextClose).trim();
        return html || null;
      }
      i = nextClose + 6;
    }
  }
  return null;
}

function parseReleasesFromHtml(html) {
  const tokenRe = /\/releases\/tag\/(v[0-9][^"'#<\s]+)|class="markdown-body[^"]*"/g;
  const events = [];
  let match;
  while ((match = tokenRe.exec(html)) !== null) {
    if (match[1]) events.push({ type: 'tag', tag: match[1], index: match.index });
    else events.push({ type: 'body', index: match.index });
  }
  const list = [];
  const seen = new Set();
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'tag' || seen.has(events[i].tag)) continue;
    const tag = events[i].tag;
    seen.add(tag);
    let end = html.length;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].type === 'tag' && events[j].tag !== tag) {
        end = events[j].index;
        break;
      }
    }
    const region = html.slice(events[i].index, end);
    const time = region.match(/<relative-time[^>]*datetime="([^"]+)"/);
    const bodyEvent = events.slice(i + 1).find((ev) => ev.type === 'body' && ev.index < end);
    const body = bodyEvent ? extractMarkdownBody(html.slice(bodyEvent.index - 40)) : null;
    list.push(listedRelease(tag, time ? time[1] : null, body));
  }
  return list;
}

async function fetchAllHtmlReleases() {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 30; page++) {
    const url = page === 1
      ? 'https://github.com/jeikl/JeikCode/releases'
      : `https://github.com/jeikl/JeikCode/releases?page=${page}`;
    const resp = await fetch(url, { headers: GITHUB_HEADERS });
    if (!resp.ok) break;
    const batch = parseReleasesFromHtml(await resp.text());
    if (!batch.length) break;
    let added = 0;
    for (const rel of batch) {
      if (seen.has(rel.tag_name)) continue;
      seen.add(rel.tag_name);
      all.push(rel);
      added++;
    }
    if (!added) break;
  }
  return all;
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function atomBody(block) {
  const match = block.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);
  if (!match) return null;
  const decoded = decodeXml(match[1]).trim();
  return decoded || null;
}

function parseReleasesFromAtom(xml) {
  const list = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<title>(?:JeikCode\s+)?(v[0-9][^<]*)<\/title>/);
    const updatedMatch = block.match(/<updated>([^<]*)<\/updated>/);
    if (!titleMatch) continue;
    const tag = titleMatch[1].trim();
    list.push(listedRelease(
      tag,
      updatedMatch ? updatedMatch[1].trim() : null,
      atomBody(block),
    ));
  }
  return list;
}

async function fetchAtomReleases() {
  const resp = await fetch('https://github.com/jeikl/JeikCode/releases.atom', {
    headers: GITHUB_HEADERS,
  });
  if (!resp.ok) return [];
  return parseReleasesFromAtom(await resp.text());
}

async function fetchAllGithubReleases() {
  const all = [];
  let url = 'https://api.github.com/repos/jeikl/JeikCode/releases?per_page=100';
  for (let page = 0; page < 20 && url; page++) {
    const ghResp = await fetch(url, {
      headers: {
        'User-Agent': 'JeikCode-Cloudflare-Relay',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!ghResp.ok) break;
    const batch = await ghResp.json();
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    url = parseNextLink(ghResp.headers.get('Link'));
  }
  return all;
}

/** Full REST row for one tag. Used only for bodies the HTML page truncated. */
async function fetchGithubReleaseByTag(tag) {
  const resp = await fetch(
    `https://api.github.com/repos/jeikl/JeikCode/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        'User-Agent': 'JeikCode-Cloudflare-Relay',
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!resp.ok) return null;
  const rel = await resp.json();
  if (!rel || !rel.tag_name) return null;
  return listedRelease(rel.tag_name, rel.published_at, rel.body);
}

/** Repair a handful of truncated bodies without downloading every page. */
async function enrichTruncatedFromRest(releases) {
  const tags = releases
    .filter((rel) => bodyLooksTruncated(rel.body))
    .slice(0, 5)
    .map((rel) => rel.tag_name);
  if (tags.length === 0) return releases;
  const repaired = await Promise.all(tags.map((tag) => fetchGithubReleaseByTag(tag)));
  return mergeReleaseLists(releases, repaired.filter(Boolean));
}

export async function onRequest(context) {
  const cacheUrl = new URL(context.request.url);
  const cacheKey = new Request(cacheUrl.toString(), context.request);
  const cache = caches.default;

  try {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) return cachedResponse;
  } catch (_) {}

  let releases = [];
  try {
    releases = await fetchAllHtmlReleases();
  } catch (_) {}

  // The public releases HTML collapses long bodies. Atom carries the complete
  // content for the newest ten entries, so use it to repair those first.
  if (releases.some((rel) => bodyLooksTruncated(rel.body))) {
    try {
      const atom = await fetchAtomReleases();
      if (atom.length) releases = mergeReleaseLists(releases, atom);
    } catch (_) {}
  }

  if (!releases.length) {
    try {
      releases = await fetchAtomReleases();
    } catch (_) {}
  }

  if (!releases.length) {
    try {
      releases = await fetchAllGithubReleases();
    } catch (_) {}
  }

  // Anything still truncated falls back to one targeted REST request per tag.
  releases = await enrichTruncatedFromRest(releases);

  if (!releases.length) {
    return new Response(JSON.stringify({ error: 'Failed to fetch release information' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store',
      },
    });
  }

  const response = new Response(JSON.stringify(releases), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Cache-Control': 'public, max-age=70, s-maxage=70, stale-while-revalidate=10',
    },
  });

  try {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  } catch (_) {}

  return response;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}
