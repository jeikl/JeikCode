/**
 * Path helpers for webui display.
 *
 * Windows `canonicalize` / `std::fs::canonicalize` returns extended-length
 * paths like `\\?\E:\desktop`. Showing that raw string in the cwd chip is
 * noisy and confuses users — strip the prefix for display only.
 */

/**
 * Strip Windows extended-length prefixes:
 *   `\\?\C:\...`  `\\?\UNC\server\share`
 *   `//?/C:/...`  `//?/UNC/server/share`   (backslashes folded to slashes)
 *   `/?/C:/...`   `/?/UNC/server/share`    (one slash dropped on the way)
 * A POSIX path is unchanged. `/?/` is removed only when a drive letter or
 * `UNC/` follows, so a real directory named `?` is kept.
 */
export function stripExtendedPathPrefix(path: string): string {
  if (!path) return '';
  if (/^\\\\\?\\UNC\\/i.test(path)) {
    return '\\\\' + path.slice('\\\\?\\UNC\\'.length);
  }
  if (/^\/\/\?\/UNC\//i.test(path)) {
    return '//' + path.slice('//?/UNC/'.length);
  }
  if (/^\/\?\/UNC\//i.test(path)) {
    return '//' + path.slice('/?/UNC/'.length);
  }
  if (/^\\\\\?\\/i.test(path)) {
    return path.slice(4);
  }
  if (/^\/\/\?\//i.test(path)) {
    return path.slice(4);
  }
  let out = path;
  if (/^\/\?\/[A-Za-z]:/.test(path)) {
    out = path.slice(3);
  }
  // IME fullwidth colon: `E：/xxxx` is the same drive as `E:/xxxx`.
  return out.replace(/^([A-Za-z])\uFF1A/, '$1:');
}

export interface FsCrumb {
  label: string;
  fullPath: string;
}

/** Breadcrumbs that understand drive letters, UNC shares, and `\\?\` / `/?/`. */
export function fsBreadcrumbs(raw: string): FsCrumb[] {
  const path = stripExtendedPathPrefix(raw).replace(/[/\\]+$/, '');
  if (!path || path === '/' || path === '\\') {
    return [{ label: '/', fullPath: '/' }];
  }

  const unc = path.match(/^\\\\([^\\]+)\\([^\\]+)\\?(.*)$/)
    || path.match(/^\/\/([^/]+)\/([^/]+)\/?(.*)$/);
  if (unc) {
    const sep = path.startsWith('\\\\') ? '\\' : '/';
    const root = sep === '\\'
      ? `\\\\${unc[1]}\\${unc[2]}`
      : `//${unc[1]}/${unc[2]}`;
    const crumbs: FsCrumb[] = [{ label: root, fullPath: root }];
    let acc = root;
    for (const part of (unc[3] || '').split(/[/\\]/).filter(Boolean)) {
      acc = joinFsChild(acc, part);
      crumbs.push({ label: part, fullPath: acc });
    }
    return crumbs;
  }

  const drive = path.match(/^([A-Za-z]:)[/\\]?(.*)$/);
  if (drive) {
    const sep = path.includes('\\') ? '\\' : '/';
    const root = drive[1] + sep;
    const crumbs: FsCrumb[] = [{ label: drive[1], fullPath: root }];
    let acc = root;
    for (const part of (drive[2] || '').split(/[/\\]/).filter(Boolean)) {
      acc = joinFsChild(acc, part);
      crumbs.push({ label: part, fullPath: acc });
    }
    return crumbs;
  }

  const parts = path.split('/').filter(Boolean);
  const crumbs: FsCrumb[] = [{ label: '/', fullPath: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += '/' + part;
    crumbs.push({ label: part, fullPath: acc });
  }
  return crumbs;
}

/** Append one directory name without gluing a `/?/` or mixed separator on. */
export function joinFsChild(baseRaw: string, name: string): string {
  const stripped = stripExtendedPathPrefix(baseRaw);
  const child = name.replace(/^[/\\]+|[/\\]+$/g, '');
  if (!child) return stripped;
  if (!stripped || stripped === '/' || stripped === '\\') {
    return '/' + child;
  }
  const trimmed = stripped.replace(/[/\\]+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed)) {
    const sep = stripped.includes('\\') ? '\\' : '/';
    return trimmed + sep + child;
  }
  const sep = trimmed.startsWith('\\\\') || trimmed.includes('\\') ? '\\' : '/';
  return trimmed + sep + child;
}

/** Collapse home prefixes to `~` for readability. */
export function collapseHomePath(path: string): string {
  const p = stripExtendedPathPrefix(path);
  if (!p) return '';
  return p
    .replace(/^\/(?:Users|home)\/[^/]+/, '~')
    .replace(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+/i, '~');
}

/** Short display path for the input cwd chip / breadcrumbs. */
export function displayPath(path: string): string {
  return collapseHomePath(path);
}

/** Page hostname that is the daemon machine itself (native folder dialog is local). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Last path segment (project folder name), separator-agnostic. */
export function pathBasename(path: string): string {
  const p = stripExtendedPathPrefix(path).replace(/[/\\]+$/, '');
  if (!p) return '';
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
