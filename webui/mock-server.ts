import type { Plugin } from 'vite';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import pathMod from 'node:path';

type MockMsg = { role: 'user' | 'assistant'; content: string; created_at: number };
type MockSession = {
  id: string;
  name: string;
  working_dir: string;
  project_hash: string;
  created_at: number;
  updated_at: number;
  messages: MockMsg[];
};

function mockNow() {
  return Date.now();
}

function newMockId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readJsonBody(req: { on: (ev: string, cb: (c?: Buffer) => void) => void }): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c?: Buffer) => {
      if (c) chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function safeDecode(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[r/g, '')
    .replace(/\x1b\[\d+;\d+r/g, '');
}

function resolveGitBashPath(): string {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  if (process.env.LOCALAPPDATA) {
    const localP = pathMod.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(localP)) return localP;
  }
  try {
    const { execSync } = require('node:child_process');
    const out = execSync('where bash', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);
    const gitBash = lines.find((l: string) => !l.toLowerCase().includes('system32') && !l.toLowerCase().includes('windowsapps'));
    if (gitBash && fs.existsSync(gitBash)) return gitBash;
  } catch {}
  return 'bash.exe';
}

export function mockApiPlugin(): Plugin {
  const mockTerminalStore = new Map<string, any>();

  async function getOrCreateTerminalSession(
    termId: string,
    reqCwd?: string,
    shellName?: string,
    initialCols = 140,
    initialRows = 36
  ) {
    let session = mockTerminalStore.get(termId);
    if (session && session.pty) return session;

    const targetCwd = reqCwd ? pathMod.resolve(reqCwd) : process.cwd();
    const shell = (shellName || 'powershell').toLowerCase();
    const count = mockTerminalStore.size + 1;
    const name = `${shellName || 'powershell'} ${count}`;

    let ptyProc: any = null;
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let bin = isWin ? 'powershell.exe' : 'bash';
    let args: string[] = ['-NoLogo'];
    let customEnv: Record<string, string> = {};

    if (isWin) {
      if (shell.includes('cmd')) {
        bin = 'cmd.exe';
        args = ['/K'];
      } else if (shell.includes('git') || shell.includes('gitbash') || (shell.includes('bash') && !shell.includes('wsl'))) {
        // 精准定位 Windows 原生 Git Bash，彻底杜绝被 System32/bash.exe 劫持到 WSL
        bin = resolveGitBashPath();
        args = ['--login', '-i'];
        customEnv = {
          MSYSTEM: 'MINGW64',
          CHERE_INVOKING: '1',
        };
      } else if (shell.includes('wsl')) {
        bin = 'wsl.exe';
        args = ['--cd', targetCwd];
      } else {
        bin = 'powershell.exe';
        args = ['-NoLogo'];
      }
    } else if (isMac) {
      bin = shell.includes('bash') ? (fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash') : (fs.existsSync('/bin/zsh') ? '/bin/zsh' : 'zsh');
      args = ['-l'];
    } else {
      // Linux: 优先用户配置 shell，带 -l login 模式加载完整环境变量
      bin = shell.includes('zsh') ? 'zsh' : shell.includes('sh') && !shell.includes('bash') ? 'sh' : 'bash';
      args = ['-l'];
    }

    try {
      const ptyModule = await import('node-pty');
      const pty = ptyModule.default || ptyModule;
      ptyProc = pty.spawn(bin, args, {
        name: 'xterm-256color',
        cols: Math.max(120, initialCols),
        rows: Math.max(20, initialRows),
        cwd: targetCwd,
        env: {
          ...process.env,
          ...customEnv,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      });
    } catch (e) {
      console.warn('[mock-server] Failed to spawn node-pty:', e);
    }

    session = {
      id: termId,
      name,
      cwd: targetCwd,
      shell: shellName || 'powershell',
      pty: ptyProc,
      buffer: '',
      sockets: new Set(),
      timestamp: Date.now(),
    };

    if (ptyProc) {
      ptyProc.onData((data: string) => {
        // 清理 ConPTY 极端 resize 刷新的空行级联，避免断线重连/初次挂载时导致视口断层
        const cleaned = data.replace(/(\u001b\[K\r\n){6,}/g, '\r\n');
        if (data.includes('\u001b[2J') || data.includes('\u001b[3J')) {
          session.buffer = cleaned;
        } else {
          session.buffer = (session.buffer || '') + cleaned;
        }
        if (session.buffer.length > 500000) {
          session.buffer = session.buffer.slice(-250000);
        }
        if (session.sockets) {
          for (const ws of session.sockets) {
            if (ws.readyState === 1 /* OPEN */) {
              try {
                ws.send(data);
              } catch {}
            }
          }
        }
      });

      ptyProc.onExit(() => {
        if (session.sockets) {
          for (const ws of session.sockets) {
            try {
              ws.send('\r\n[Process exited]\r\n');
            } catch {}
          }
        }
      });
    }

    mockTerminalStore.set(termId, session);
    return session;
  }
  const sessionQueues = new Map<string, any[]>();
  const runningChats = new Set<string>();
  const sidebarHidden = new Set<string>(['proj_fetch']);
  const sidebarPinned: Array<{
    hash: string;
    name: string;
    working_dir: string;
    session_count: number;
    created_at: number;
    last_updated: number;
  }> = [];
  const mockSessions: MockSession[] = [
    {
      id: 'sess_input_anomaly',
      name: '输入框布局异常排查',
      working_dir: 'E:/code/jeikcode',
      project_hash: 'proj_jeikcode',
      created_at: mockNow() - 360000,
      updated_at: mockNow() - 360000,
      messages: [
        {
          role: 'user',
          content: '输入框布局怪异，而且还有点透明穿透，在移动端还被 git 面板占满了，请排查一下。',
          created_at: mockNow() - 120000,
        },
        {
          role: 'assistant',
          content:
            '好的，已为您定位到相关原因并开始修复：\n\n1. **双层嵌套问题**：外层容器与内层药丸框重叠导致嵌套异常；\n2. **移动端 Git 面板**：移动端默认未折叠，导致主视口被完全遮挡；\n3. **底栏透明度**：底栏背景缺少坚实不透明底色与合适的堆叠层级。\n\n正在进行系统性重构与修复。',
          created_at: mockNow() - 100000,
        },
      ],
    },
    {
      id: 'sess_pr5_review',
      name: 'JeikCode PR 5 审核',
      working_dir: 'E:/code/jeikcode',
      project_hash: 'proj_jeikcode',
      created_at: mockNow() - 2280000,
      updated_at: mockNow() - 2280000,
      messages: [
        { role: 'user', content: '帮我审核一下这个 PR。', created_at: mockNow() - 2280000 },
        { role: 'assistant', content: '可以，请贴 diff 或指定提交。', created_at: mockNow() - 2270000 },
      ],
    },
    {
      id: 'sess_channel_popup',
      name: 'jeikcode添加更新通道弹窗',
      working_dir: 'E:/code/jeikcode',
      project_hash: 'proj_jeikcode',
      created_at: mockNow() - 3600000,
      updated_at: mockNow() - 3600000,
      messages: [],
    },
  ];

  const toMeta = (s: MockSession) => ({
    id: s.id,
    name: s.name,
    working_dir: s.working_dir,
    project_hash: s.project_hash,
    created_at: s.created_at,
    updated_at: s.updated_at,
    message_count: s.messages.length,
  });

  const toDetail = (s: MockSession, search: URLSearchParams) => {
    const tail = search.get('tail') ? Number(search.get('tail')) : undefined;
    const offsetQ = search.get('offset') ? Number(search.get('offset')) : undefined;
    const limitQ = search.get('limit') ? Number(search.get('limit')) : undefined;
    const all = s.messages;
    let offset = 0;
    let slice = all;
    if (Number.isFinite(offsetQ) && Number.isFinite(limitQ)) {
      offset = Math.max(0, offsetQ as number);
      slice = all.slice(offset, offset + (limitQ as number));
    } else if (Number.isFinite(tail) && (tail as number) < all.length) {
      offset = all.length - (tail as number);
      slice = all.slice(offset);
    }
    const turns = all
      .map((m, index) => (m.role === 'user' ? { index, text: m.content.slice(0, 80) } : null))
      .filter((t): t is { index: number; text: string } => t != null)
      .map((t, i) => ({ ...t, ordinal: i + 1 }));
    return {
      id: s.id,
      name: s.name,
      working_dir: s.working_dir,
      created_at: s.created_at,
      updated_at: s.updated_at,
      message_count: all.length,
      offset,
      turns,
      messages: slice,
      project_hash: s.project_hash,
    };
  };

  const findSession = (id: string) => mockSessions.find((s) => s.id === id);

  const createSessionRecord = (workingDir?: string, title?: string): MockSession => {
    const now = mockNow();
    const session: MockSession = {
      id: newMockId('sess'),
      name: title && title.trim() ? title.trim().slice(0, 40) : `session-${now}`,
      working_dir: workingDir || 'E:/code/jeikcode',
      project_hash: 'proj_jeikcode',
      created_at: now,
      updated_at: now,
      messages: [],
    };
    mockSessions.unshift(session);
    return session;
  };

  return {
    name: 'vite-plugin-mock-api',
    apply: 'serve',
    configureServer(server) {
      // 接入工业级 WebSocket PTY 终端双向串流服务
      import('ws').then(({ WebSocketServer }) => {
        const wss = new WebSocketServer({ noServer: true });
        server.httpServer?.on('upgrade', (req, socket, head) => {
          const url = new URL(req.url || '', 'http://localhost');
          if (url.pathname === '/terminal/ws') {
            wss.handleUpgrade(req, socket, head, (ws: any) => {
              wss.emit('connection', ws, req);
            });
          }
        });

        wss.on('connection', async (ws: any, req: any) => {
          const url = new URL(req.url || '', 'http://localhost');
          const termId = url.searchParams.get('id') || `term_${Date.now().toString(36)}`;
          const reqCwd = url.searchParams.get('cwd') || process.cwd();
          const reqShell = url.searchParams.get('shell') || 'powershell';
          const reqCols = Number(url.searchParams.get('cols')) || 120;
          const reqRows = Number(url.searchParams.get('rows')) || 32;

          const session = await getOrCreateTerminalSession(termId, reqCwd, reqShell, reqCols, reqRows);

          session.sockets = session.sockets || new Set();
          session.sockets.add(ws);

          // 发送累计终端屏幕输出（断线重连/F5刷新状态无缝秒级恢复）
          if (session.buffer) {
            ws.send(session.buffer);
            // 触发 ConPTY 重新同步当前活动行的光标位置，杜绝光标错位跳进历史文本半截！
            setTimeout(() => {
              if (session.pty && ws.readyState === 1) {
                try {
                  session.pty.resize(session.pty.cols, session.pty.rows);
                } catch {}
              }
            }, 60);
          }

          ws.on('message', (msg: any) => {
            const text = msg.toString();
            try {
              if (text.startsWith('{"resize":')) {
                const parsed = JSON.parse(text);
                if (parsed.resize && session.pty) {
                  const cols = Math.max(30, Math.min(500, Number(parsed.resize.cols) || 80));
                  const rows = Math.max(5, Math.min(200, Number(parsed.resize.rows) || 24));
                  if (session.pty.cols !== cols || session.pty.rows !== rows) {
                    session.pty.resize(cols, rows);
                  }
                }
                return;
              }
            } catch {}
            if (session.pty) {
              session.pty.write(text);
            }
          });

          ws.on('close', () => {
            session.sockets.delete(ws);
          });
        });
      }).catch((err) => {
        console.warn('[mock-server] WebSocket terminal server initialization skipped:', err);
      });

      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';
        const parsedUrl = new URL(url, 'http://localhost');
        let pathname = parsedUrl.pathname;
        if (pathname.startsWith('/api')) {
          pathname = pathname.slice(4);
        }
        if (!pathname.startsWith('/')) {
          pathname = '/' + pathname;
        }

        const isApi =
          pathname.startsWith('/fs/') ||
          pathname.startsWith('/terminal/') ||
          pathname.startsWith('/git/') ||
          pathname.startsWith('/chat/') ||
          pathname === '/events' ||
          pathname === '/health' ||
          pathname === '/config' ||
          pathname === '/models' ||
          pathname === '/skills';

        if (!isApi) {
          // 如果请求的是工作区根目录资源（例如 ./assets/jeikcode-logo.svg）
          if (pathname.startsWith('/assets/')) {
            const rootAsset = pathMod.resolve(process.cwd(), '..', pathname.slice(1));
            if (fs.existsSync(rootAsset)) {
              const ext = pathMod.extname(rootAsset).toLowerCase();
              const mimeMap: Record<string, string> = {
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.ico': 'image/x-icon',
              };
              res.statusCode = 200;
              res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
              return fs.createReadStream(rootAsset).pipe(res);
            }
          }

          if (
            url === '/' ||
            url.startsWith('/?') ||
            req.headers.accept?.includes('text/html') ||
            url.startsWith('/@') ||
            url.startsWith('/src') ||
            url.startsWith('/node_modules') ||
            url.endsWith('.html') ||
            url.endsWith('.js') ||
            url.endsWith('.ts') ||
            url.endsWith('.tsx') ||
            url.endsWith('.css') ||
            url.endsWith('.woff') ||
            url.endsWith('.woff2') ||
            url.endsWith('.ttf')
          ) {
            return next();
          }
        }

        const sendJson = (data: any, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(data));
        };

        // Global SSE events stream（提供保活长连接，彻底解决客户端 400ms 狂刷 events 导致的 CPU 高占用）
        if (pathname === '/events') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.write(':ok\n\n');
          const heartbeat = setInterval(() => {
            try {
              res.write(':ping\n\n');
            } catch {
              clearInterval(heartbeat);
            }
          }, 15000);
          req.on('close', () => {
            clearInterval(heartbeat);
          });
          return;
        }

        // Health
        if (pathname === '/health') {
          return sendJson({
            status: 'ok',
            version: '7.1.53-beta.3',
            working_dir: 'E:/code/jeikcode',
          });
        }

        // Config
        if (pathname === '/config') {
          return sendJson({
            path: 'E:/code/jeikcode/config.toml',
            default_provider: 'gemini-2.5-pro',
            providers: [
              {
                name: 'gemini-2.5-pro',
                model_id: 'gemini-2.5-pro',
                type: 'gemini',
                base_url: 'https://generativelanguage.googleapis.com',
                context_window: 1000000,
                max_output_tokens: 65536,
                supports_vision: true,
                reasoning_effort: 'high',
                reasoning_history: 'include',
                account: 'google-default',
                is_default: true,
              },
              {
                name: 'claude-3-7-sonnet',
                model_id: 'claude-3-7-sonnet-20250219',
                type: 'anthropic',
                base_url: 'https://api.anthropic.com',
                context_window: 200000,
                max_output_tokens: 64000,
                supports_vision: true,
                reasoning_effort: 'medium',
                account: 'anthropic-primary',
              },
              {
                name: 'o3-mini',
                model_id: 'o3-mini',
                type: 'openai',
                context_window: 200000,
                max_output_tokens: 100000,
                reasoning_effort: 'high',
                account: 'openai-default',
              },
            ],
            accounts: [
              {
                id: 'google-default',
                type: 'gemini',
                base_url: 'https://generativelanguage.googleapis.com',
                has_api_key: true,
              },
              {
                id: 'anthropic-primary',
                type: 'anthropic',
                base_url: 'https://api.anthropic.com',
                has_api_key: true,
              },
              {
                id: 'openai-default',
                type: 'openai',
                base_url: 'https://api.openai.com/v1',
                has_api_key: true,
              },
            ],
            language: 'zh',
          });
        }

        // Models
        if (pathname === '/models') {
          return sendJson([
            {
              id: 'gemini-2.5-pro',
              name: 'gemini-2.5-pro',
              provider: 'gemini-2.5-pro',
              type: 'gemini',
              supports_vision: true,
              context_window: 1000000,
              max_output_tokens: 65536,
              effort_applicable: true,
              reasoning_effort: 'high',
              reasoning_levels: ['off', 'low', 'medium', 'high'],
              is_default: true,
            },
            {
              id: 'claude-3-7-sonnet',
              name: 'claude-3-7-sonnet',
              provider: 'claude-3-7-sonnet',
              type: 'anthropic',
              supports_vision: true,
              context_window: 200000,
              max_output_tokens: 64000,
              effort_applicable: true,
              reasoning_effort: 'medium',
              reasoning_levels: ['low', 'medium', 'high'],
            },
            {
              id: 'o3-mini',
              name: 'o3-mini',
              provider: 'o3-mini',
              type: 'openai',
              supports_vision: false,
              context_window: 200000,
              max_output_tokens: 100000,
              effort_applicable: true,
              reasoning_effort: 'high',
              reasoning_levels: ['low', 'medium', 'high'],
            },
          ]);
        }

        // Skills
        if (pathname === '/skills') {
          return sendJson([
            { name: 'review', description: '审核代码变更与 Git Diff' },
            { name: 'explain', description: '详细解释选中的代码或实现逻辑' },
            { name: 'test', description: '运行单元测试并排查失败' },
          ]);
        }

        // MCP status
        if (pathname === '/mcp/status') {
          return sendJson({
            servers: [
              { name: 'filesystem', status: 'running', tools: 4 },
              { name: 'git', status: 'running', tools: 6 },
              { name: 'web-search', status: 'running', tools: 2 },
            ],
          });
        }

        const sidebarView = () => ({ hidden: [...sidebarHidden], pinned: sidebarPinned });

        if (pathname === '/projects/sidebar') {
          return sendJson(sidebarView());
        }
        if (pathname === '/projects/sidebar/hide') {
          void readJsonBody(req).then((body) => {
            if (typeof body.hash === 'string' && body.hash) sidebarHidden.add(body.hash);
            sendJson(sidebarView());
          });
          return;
        }
        if (pathname === '/projects/sidebar/show') {
          void readJsonBody(req).then((body) => {
            const path = typeof body.path === 'string' ? body.path : '';
            const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
            const hash = `pin_${name || 'dir'}`;
            sidebarHidden.delete(hash);
            if (!sidebarPinned.some((p) => p.hash === hash)) {
              sidebarPinned.push({
                hash,
                name,
                working_dir: path,
                session_count: 0,
                created_at: mockNow(),
                last_updated: mockNow(),
              });
            }
            sendJson(sidebarPinned.find((p) => p.hash === hash));
          });
          return;
        }
        if (pathname === '/projects/sidebar/reveal') {
          void readJsonBody(req).then((body) => {
            if (typeof body.hash === 'string' && body.hash) sidebarHidden.delete(body.hash);
            sendJson(sidebarView());
          });
          return;
        }

        // Projects
        if (pathname === '/projects') {
          return sendJson([
            {
              hash: 'proj_jeikcode',
              name: 'jeikcode',
              working_dir: 'E:/code/jeikcode',
              session_count: 87,
            },
            {
              hash: 'proj_antigravity',
              name: 'Antigravity-Engine',
              working_dir: 'E:/code/Antigravity',
              session_count: 117,
            },
            {
              hash: 'proj_admin',
              name: 'Administrator-Tools',
              working_dir: 'E:/code/Administrator',
              session_count: 5,
            },
            {
              hash: 'proj_fetch',
              name: 'Jeik-Web-Fetch',
              working_dir: 'E:/code/Jeik-Web-Fetch',
              session_count: 2,
            },
          ]);
        }

        // Current Project
        if (pathname === '/project') {
          return sendJson({
            hash: 'proj_jeikcode',
            name: 'jeikcode',
            working_dir: 'E:/code/jeikcode',
            display_path: 'E:\\code\\jeikcode',
          });
        }

        // Sessions list / create
        if (pathname === '/sessions') {
          if (req.method === 'POST') {
            void readJsonBody(req).then((body) => {
              const created = createSessionRecord(body.working_dir, body.title);
              sendJson(created);
            });
            return;
          }
          return sendJson(mockSessions.map(toMeta));
        }

        if (pathname === '/sessions/search') {
          const q = (parsedUrl.searchParams.get('q') || '').trim().toLowerCase();
          const hits = mockSessions.filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
          return sendJson(hits.map(toMeta));
        }

        if (pathname.startsWith('/sessions/resolve/')) {
          const id = decodeURIComponent(pathname.slice('/sessions/resolve/'.length));
          const found = findSession(id);
          if (!found) {
            res.statusCode = 404;
            res.end();
            return;
          }
          return sendJson(toMeta(found));
        }

        // Project sessions collection
        {
          const projList = pathname.match(/^\/projects\/([^/]+)\/sessions$/);
          if (projList) {
            const hash = decodeURIComponent(projList[1]);
            return sendJson(mockSessions.filter((s) => s.project_hash === hash).map(toMeta));
          }
        }

        {
          const fresh = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/freshness$/);
          if (fresh) {
            const sess = findSession(decodeURIComponent(fresh[2]));
            if (!sess) {
              res.statusCode = 404;
              res.end();
              return;
            }
            const bytes = JSON.stringify(sess.messages).length;
            return sendJson({ bytes, mtime_ms: sess.updated_at, running: runningChats.has(sess.id) });
          }
        }

        {
          const rename = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/rename$/);
          if (rename && req.method === 'PATCH') {
            void readJsonBody(req).then((body) => {
              const sess = findSession(decodeURIComponent(rename[2]));
              if (!sess) {
                res.statusCode = 404;
                res.end();
                return;
              }
              if (typeof body.name === 'string' && body.name.trim()) sess.name = body.name.trim();
              sess.updated_at = mockNow();
              sendJson({ ok: true });
            });
            return;
          }
        }

        {
          const trunc = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/truncate$/);
          if (trunc && req.method === 'POST') {
            void readJsonBody(req).then((body) => {
              const sess = findSession(decodeURIComponent(trunc[2]));
              if (!sess) {
                res.statusCode = 404;
                res.end();
                return;
              }
              const targetIdx = typeof body.target_index === 'number' ? body.target_index : 0;
              if (targetIdx >= 0 && targetIdx < sess.messages.length) {
                sess.messages = sess.messages.slice(0, targetIdx);
              }
              sess.updated_at = mockNow();
              sendJson({ success: true, revision: sess.messages.length, target_index: targetIdx });
            });
            return;
          }
        }

        {
          const one = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)$/);
          if (one) {
            const sess = findSession(decodeURIComponent(one[2]));
            if (!sess) {
              res.statusCode = 404;
              res.end();
              return;
            }
            if (req.method === 'DELETE') {
              const idx = mockSessions.findIndex((s) => s.id === sess.id);
              if (idx >= 0) mockSessions.splice(idx, 1);
              return sendJson({ ok: true });
            }
            return sendJson(toDetail(sess, parsedUrl.searchParams));
          }
        }

        if (pathname.startsWith('/sessions/')) {
          const sessId = decodeURIComponent(pathname.replace('/sessions/', ''));
          const sess = findSession(sessId);
          if (!sess) {
            res.statusCode = 404;
            res.end();
            return;
          }
          return sendJson(toDetail(sess, parsedUrl.searchParams));
        }

        // Active chat sessions
        if (pathname === '/chat/active') {
          return sendJson(Array.from(runningChats));
        }

        if (pathname === '/runtime/sessions') {
          return sendJson([]);
        }

        // Approval mode
        if (pathname === '/approval_mode') {
          return sendJson('build');
        }

        // Remote access
        if (pathname === '/remote-access') {
          return sendJson({
            active: true,
            host: '0.0.0.0',
            port: 13457,
            token: 'demo-remote-token-123456',
            no_token: false,
            urls: ['http://127.0.0.1:13457', 'http://192.168.123.20:13457'],
          });
        }

        // Chat Queue (GET & POST)
        if (pathname === '/chat/queue') {
          if (req.method === 'GET') {
            const sid = parsedUrl.searchParams.get('session_id') || '';
            const items = sessionQueues.get(sid) || [];
            return sendJson(items);
          }
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
              try {
                const parsed = JSON.parse(body);
                if (parsed.session_id) {
                  sessionQueues.set(parsed.session_id, parsed.items || []);
                }
              } catch {}
              sendJson({ success: true });
            });
            return;
          }
        }

        // Chat Steer
        if (pathname === '/chat/steer') {
          return sendJson({ success: true });
        }

        // Git Repos
        if (pathname === '/git/repos') {
          return sendJson({
            repos: [
              {
                name: 'jeikcode (beta)',
                root: 'E:/code/jeikcode',
                is_root: true,
                branch: 'beta',
              },
            ],
            current: 'E:/code/jeikcode',
          });
        }

        // Git Branches
        if (pathname === '/git/branches') {
          return sendJson({
            is_repo: true,
            repo_root: 'E:/code/jeikcode',
            remote_url: 'https://github.com/jeikl/JeikCode.git',
            current: 'beta',
            local: ['beta', 'main', 'feature/git-ui-responsive'],
            remote: ['origin/beta', 'origin/main'],
          });
        }

        // Git Graph
        if (pathname === '/git/graph') {
          const nowSec = Math.floor(Date.now() / 1000);
          return sendJson({
            is_repo: true,
            current_branch: 'beta',
            remote_url: 'https://github.com/jeikl/JeikCode.git',
            commits: [
              {
                hash: '0f2e5aca601b3c95e1e07297e59bbf62ba203e91',
                short_hash: '0f2e5aca6',
                parents: ['e60c5535492d3f71c48bf5bca253e9ec90346081'],
                author_name: 'Bui Thanh Xuan',
                author_email: 'buithanhxuan2261@gmail.com',
                timestamp: nowSec - 900,
                message:
                  'fix(daemon): harden approval response correlation (#8)\n\n* fix(daemon): harden approval response correlation\n\nCo-Authored-By: JeikCode <code@jeikcode.top>\n\n* fix(daemon): preserve interactive request timeout\n\nCo-Authored-By: JeikCode <code@jeikcode.top>\n\n* fix(daemon): close approval runtime race windows\n\nCo-Authored-By: JeikCode <code@jeikcode.top>',
                refs: [],
                total_files: 38,
                total_additions: 3123,
                total_deletions: 634,
              },
              {
                hash: 'e60c5535492d3f71c48bf5bca253e9ec90346081',
                short_hash: 'e60c55354',
                parents: ['a2b9a8adc735e5d36e8b4e7fe32b001a18209bb4'],
                author_name: 'Jeik',
                author_email: 'jeikliu@outlook.com',
                timestamp: nowSec - 2040,
                message:
                  'feat(capabilities): enhance parameter validation feedback with multi-field and hierarchy support\n\n- Provide granular diagnostic messages for nested schema properties\n- Add backward-compatible fallback for unvalidated parameters\n- Improve error reporting in tool invocation pipeline\n\nCo-Authored-By: JeikCode <code@jeikcode.top>\nCo-Authored-By: Claude <noreply@anthropic.com>',
                refs: ['beta', 'origin/beta'],
                total_files: 8,
                total_additions: 86,
                total_deletions: 19,
              },
              {
                hash: 'a2b9a8adc735e5d36e8b4e7fe32b001a18209bb4',
                short_hash: 'a2b9a8adc',
                parents: ['5cb4d73c038943b0132f82b239a2edb51e6fd104'],
                author_name: 'Jeik',
                author_email: 'jeikliu@outlook.com',
                timestamp: nowSec - 3600,
                message:
                  'chore(release): bump version to v7.1.53-beta.13\n\nRelease v7.1.53-beta.13 includes:\n- Responsive Git panel redesign with compact icon-only copy buttons\n- Consolidated commit action dropdown menu\n- Optimized full-width drawer for mobile viewports\n\nCo-Authored-By: JeikCode <code@jeikcode.top>\nCo-Authored-By: Gemini <noreply@google.com>',
                refs: ['tag: v7.1.53-beta.13'],
                total_files: 14,
                total_additions: 42,
                total_deletions: 27,
              },
              {
                hash: '5cb4d73c038943b0132f82b239a2edb51e6fd104',
                short_hash: '5cb4d73',
                parents: ['2e540dbbef4d783d2b1c112ef142ff2abf28d949'],
                author_name: 'Jeik',
                author_email: 'jeikliu@outlook.com',
                timestamp: nowSec - 7200,
                message:
                  'refactor(skills): adhere strictly to plural .agents convention\n\nEnsure backward compatibility while transitioning to standard directory layout across all platforms.',
                refs: [],
                total_files: 5,
                total_additions: 38,
                total_deletions: 12,
              },
              {
                hash: '2e540dbbef4d783d2b1c112ef142ff2abf28d949',
                short_hash: '2e540db',
                parents: ['258007cc85d2ff5ac51456dfc3fe6451e99d6beb'],
                author_name: 'Jeik',
                author_email: 'jeikliu@outlook.com',
                timestamp: nowSec - 14400,
                message:
                  'docs(teaches): document expanded universal skill directories\n\n- Update teaches guide with comprehensive directory hierarchies\n- Clarify global vs project-level precedence rules\n\nCo-Authored-By: JeikCode <code@jeikcode.top>',
                refs: [],
                total_files: 3,
                total_additions: 55,
                total_deletions: 6,
              },
              {
                hash: '258007cc85d2ff5ac51456dfc3fe6451e99d6beb',
                short_hash: '258007c',
                parents: ['11f0264174823026f129a72cb6046d43bb857a6e'],
                author_name: 'Jeik',
                author_email: 'jeikliu@outlook.com',
                timestamp: nowSec - 28800,
                message:
                  'feat(skills): support universal .agent/skills discovery\n\nAdd unified capability discovery across project and user directories:\n- Scan ~/.agent/skills, ~/.agents/skills, and ./.agent/skills\n- Automatic prompt hot-reloading without daemon restart\n- Preserve skill priority precedence rules\n\nCo-Authored-By: JeikCode <code@jeikcode.top>',
                refs: [],
                total_files: 6,
                total_additions: 74,
                total_deletions: 15,
              },
              {
                hash: '11f0264174823026f129a72cb6046d43bb857a6e',
                short_hash: '11f0264',
                parents: [],
                author_name: 'Jeik',
                author_email: 'jeikliu@outlook.com',
                timestamp: nowSec - 43200,
                message: 'feat(webui): add responsive commit details card in git panel',
                refs: ['main', 'origin/main'],
                total_files: 10,
                total_additions: 120,
                total_deletions: 45,
              },
            ],
          });
        }

        // Git Commit Detail
        if (pathname === '/git/commit-detail') {
          const hash = parsedUrl.searchParams.get('hash') || 'a2b9a8adc735e5d36e8b4e7fe32b001a18209bb4';
          return sendJson({
            hash,
            files: [
              { path: 'CHANGELOG.md', status: 'M', additions: 15, deletions: 0 },
              { path: 'Cargo.lock', status: 'M', additions: 12, deletions: 12 },
              { path: 'Cargo.toml', status: 'M', additions: 1, deletions: 1 },
              { path: 'webui/package.json', status: 'M', additions: 1, deletions: 1 },
              { path: 'webui/src/components/GitPanel.tsx', status: 'M', additions: 38, deletions: 15 },
              { path: 'webui/src/styles/app.css', status: 'M', additions: 52, deletions: 18 },
            ],
            total_files: 6,
            total_additions: 119,
            total_deletions: 47,
          });
        }

        // Git Checkout
        if (pathname === '/git/checkout') {
          return sendJson({
            success: true,
            branch: 'beta',
            message: 'Switched to branch beta',
          });
        }

        // Git Actions (create_branch, create_tag, cherry_pick, revert)
        if (pathname === '/git/action') {
          return sendJson({
            success: true,
            message: 'Git operation completed successfully',
          });
        }

        // Git Status
        if (pathname === '/git/status') {
          const reqCwd = parsedUrl.searchParams.get('cwd') || pathMod.resolve(process.cwd(), '..');
          try {
            const { execFileSync } = await import('node:child_process');
            const out = execFileSync('git', ['status', '--porcelain=v1', '-u', '--branch'], {
              cwd: reqCwd,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'ignore'],
            });
            let current_branch = 'beta';
            let tracking_branch = null;
            let ahead = 0;
            let behind = 0;
            const staged: any[] = [];
            const unstaged: any[] = [];
            const untracked: any[] = [];

            for (const line of out.split(/\r?\n/)) {
              const trimmed = line.trimEnd();
              if (trimmed.startsWith('##')) {
                const header = trimmed.replace(/^##\s*/, '').trim();
                const [bPart, track] = header.split('[');
                if (bPart && bPart.includes('...')) {
                  const [cur, tr] = bPart.split('...');
                  current_branch = cur.trim();
                  tracking_branch = tr ? tr.trim() : null;
                } else if (bPart) {
                  current_branch = bPart.trim();
                }
                if (track) {
                  const mAhead = track.match(/ahead (\d+)/);
                  if (mAhead) ahead = parseInt(mAhead[1], 10);
                  const mBehind = track.match(/behind (\d+)/);
                  if (mBehind) behind = parseInt(mBehind[1], 10);
                }
                continue;
              }
              if (trimmed.length < 4) continue;
              const x = trimmed[0];
              const y = trimmed[1];
              const filePath = trimmed.slice(3).trim().replace(/^"|"$/g, '');
              if (x === '?' && y === '?') {
                untracked.push({ path: filePath, status: '?', staged: false });
              } else {
                if (x && x !== ' ') {
                  staged.push({ path: filePath, status: x, staged: true });
                }
                if (y && y !== ' ') {
                  unstaged.push({ path: filePath, status: y, staged: false });
                }
              }
            }

            return sendJson({
              is_repo: true,
              current_branch,
              tracking_branch,
              ahead,
              behind,
              staged,
              unstaged,
              untracked,
            });
          } catch {
            return sendJson({
              is_repo: true,
              current_branch: 'beta',
              ahead: 0,
              behind: 0,
              staged: [],
              unstaged: [],
              untracked: [],
            });
          }
        }

        // Git Discard
        if (pathname === '/git/discard') {
          const body = await readJsonBody(req);
          const reqCwd = body.cwd || pathMod.resolve(process.cwd(), '..');
          try {
            const { execFileSync } = await import('node:child_process');
            if (body.isUntracked) {
              execFileSync('git', ['clean', '-fd', '--', body.path], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            } else {
              try {
                execFileSync('git', ['restore', '--staged', '--worktree', '--', body.path], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
              } catch {
                execFileSync('git', ['clean', '-fd', '--', body.path], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
              }
            }
            return sendJson({ success: true, message: 'Discarded successfully' });
          } catch (e: any) {
            return sendJson({ success: true, message: 'Discarded' });
          }
        }

        // Git Stage
        if (pathname === '/git/stage') {
          const body = await readJsonBody(req);
          const reqCwd = body.cwd || pathMod.resolve(process.cwd(), '..');
          try {
            const { execFileSync } = await import('node:child_process');
            if (body.all) {
              execFileSync('git', ['add', '-A'], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            } else if (body.path) {
              execFileSync('git', ['add', '--', body.path], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            }
            return sendJson({ success: true });
          } catch {
            return sendJson({ success: true });
          }
        }

        // Git Unstage
        if (pathname === '/git/unstage') {
          const body = await readJsonBody(req);
          const reqCwd = body.cwd || pathMod.resolve(process.cwd(), '..');
          try {
            const { execFileSync } = await import('node:child_process');
            if (body.all) {
              execFileSync('git', ['restore', '--staged', '.'], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            } else if (body.path) {
              execFileSync('git', ['restore', '--staged', '--', body.path], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            }
            return sendJson({ success: true });
          } catch {
            return sendJson({ success: true });
          }
        }

        // Git Fetch
        if (pathname === '/git/fetch') {
          const body = await readJsonBody(req);
          const reqCwd = body.cwd || pathMod.resolve(process.cwd(), '..');
          try {
            const { execFileSync } = await import('node:child_process');
            execFileSync('git', ['fetch', '--all', '--prune', '--tags'], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            return sendJson({ success: true, message: 'Fetched successfully', has_remote: true });
          } catch (e: any) {
            return sendJson({ success: false, message: e?.message || 'Fetch failed', has_remote: true });
          }
        }

        // Git Pull
        if (pathname === '/git/pull') {
          const body = await readJsonBody(req);
          const reqCwd = body.cwd || pathMod.resolve(process.cwd(), '..');
          try {
            const { execFileSync } = await import('node:child_process');
            execFileSync('git', ['pull'], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            return sendJson({ success: true, message: 'Pulled successfully' });
          } catch (e: any) {
            return sendJson({ success: false, message: e?.message || 'Pull failed' });
          }
        }

        // Git Push
        if (pathname === '/git/push') {
          const body = await readJsonBody(req);
          const reqCwd = body.cwd || pathMod.resolve(process.cwd(), '..');
          try {
            const { execFileSync } = await import('node:child_process');
            execFileSync('git', ['push'], { cwd: reqCwd, stdio: ['pipe', 'pipe', 'ignore'] });
            return sendJson({ success: true, message: 'Pushed successfully' });
          } catch (e: any) {
            return sendJson({ success: false, message: e?.message || 'Push failed' });
          }
        }

        if (pathname === '/chat/watch') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.write(`data: ${JSON.stringify({ type: 'done', session_id: parsedUrl.searchParams.get('session_id') || '', tokens: null, tool_calls: null })}\n\n`);
          res.end();
          return;
        }

        // Chat Stream SSE Mock
        if (pathname === '/chat') {
          void readJsonBody(req).then((body) => {
            const userText = typeof body.message === 'string' ? body.message : '';
            let sess = typeof body.session_id === 'string' ? findSession(body.session_id) : undefined;
            if (!sess) {
              const title = (userText.split('\n')[0] || '').trim().slice(0, 20);
              sess = createSessionRecord(body.working_dir, title || undefined);
            }
            const now = mockNow();
            sess.messages.push({ role: 'user', content: userText, created_at: now });
            sess.updated_at = now;
            if (sess.name.startsWith('session-') && userText.trim()) {
              sess.name = userText.trim().slice(0, 20);
            }
            runningChats.add(sess.id);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const sendEvent = (payload: unknown) => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            };
            sendEvent({ type: 'session_assigned', session_id: sess.id });
            sendEvent({ type: 'user', content: userText, session_id: sess.id, created_at: now });
            const reply = `已收到：${userText.slice(0, 80) || '（空消息）'}\n\n这是 mock 回复，会话 ${sess.name} 可以继续发送。`;
            setTimeout(() => {
              sendEvent({ type: 'text', content: reply });
            }, 220);
            setTimeout(() => {
              sess!.messages.push({ role: 'assistant', content: reply, created_at: mockNow() });
              sess!.updated_at = mockNow();
              runningChats.delete(sess!.id);
              sendEvent({
                type: 'done',
                session_id: sess!.id,
                tokens: { prompt: 1800, completion: 40, total: 1840, cached: 0 },
                tool_calls: null,
              });
              res.end();
            }, 700);
          });
          return;
        }

        // ==================== FS / EXPLORER MOCK API ====================
        if (pathname === '/fs/list' || pathname === '/fs/tree') {
          const reqPath = parsedUrl.searchParams.get('path') || process.cwd();
          try {
            const absDir = pathMod.resolve(reqPath);
            const entries = await fsPromises.readdir(absDir, { withFileTypes: true });

            // 调用 Git 原生 check-ignore (-v) 严格判定每个条目（含继承忽略、递归子项与 !白名单反转）
            const ignoredPaths = new Set<string>();
            const whitelistedPaths = new Set<string>();
            let parentIsIgnored = false;

            try {
              const { execFileSync } = await import('node:child_process');
              const normAbsDir = absDir.replace(/\\/g, '/');

              // 探测当前所在父目录本身是否已处于 git 忽略集合中
              try {
                const parentCheck = execFileSync('git', ['check-ignore', '--', absDir], {
                  encoding: 'utf8',
                  stdio: ['pipe', 'pipe', 'ignore'],
                });
                if (parentCheck.trim()) {
                  parentIsIgnored = true;
                }
              } catch {}

              const pathsToCheck = entries.map((e) => pathMod.join(absDir, e.name));
              if (pathsToCheck.length > 0) {
                // 使用 -v 识别是否存在 ! 前缀的白名单反向规则
                const gitOut = execFileSync('git', ['check-ignore', '-v', '--', ...pathsToCheck], {
                  encoding: 'utf8',
                  stdio: ['pipe', 'pipe', 'ignore'],
                });
                for (const line of gitOut.split(/\r?\n/)) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  // 输出格式形如: <source>:<lineno>:<pattern>\t<pathname>
                  const parts = trimmed.split('\t');
                  const rulePart = parts[0] || '';
                  const targetPath = parts[1] || '';
                  const resolvedPath = pathMod.resolve(targetPath).replace(/\\/g, '/');

                  const rulePattern = rulePart.split(':').slice(2).join(':').trim();
                  if (rulePattern.startsWith('!')) {
                    whitelistedPaths.add(resolvedPath.toLowerCase());
                  } else {
                    ignoredPaths.add(resolvedPath.toLowerCase());
                  }
                }
              }
            } catch {
              // 非 git 仓库或未安装 git 时静默容错
            }

            const items = entries
              .filter((e) => e.name !== '.git')
              .map((e) => {
                const fullP = pathMod.join(absDir, e.name).replace(/\\/g, '/');
                const lowerP = fullP.toLowerCase();
                const isBuiltinIgnored = e.name === 'target' || e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.');
                let isIgnored = false;

                if (whitelistedPaths.has(lowerP)) {
                  // 命中 ! 白名单，明确不忽略，正常色
                  isIgnored = false;
                } else if (ignoredPaths.has(lowerP)) {
                  // 明确被 git 忽略规则命中
                  isIgnored = true;
                } else if (parentIsIgnored || isBuiltinIgnored) {
                  // 继承自父目录的忽略状态，或者属于构建产物/点开头配置目录
                  isIgnored = true;
                }

                return {
                  name: e.name,
                  path: fullP,
                  is_dir: e.isDirectory(),
                  is_ignored: isIgnored,
                };
              })
              .sort((a, b) => {
                if (a.is_dir === b.is_dir) return a.name.localeCompare(b.name);
                return a.is_dir ? -1 : 1;
              });

            return sendJson({
              path: absDir.replace(/\\/g, '/'),
              entries: items,
              dirs: items.filter((i) => i.is_dir).map((i) => i.name),
              files: items.filter((i) => !i.is_dir).map((i) => i.name),
            });
          } catch {
            // Mock Fallback
            return sendJson({
              path: reqPath.replace(/\\/g, '/'),
              entries: [
                { name: 'crates', path: `${reqPath}/crates`, is_dir: true, is_ignored: false },
                { name: 'webui', path: `${reqPath}/webui`, is_dir: true, is_ignored: false },
                { name: 'docs', path: `${reqPath}/docs`, is_dir: true, is_ignored: false },
                { name: 'target', path: `${reqPath}/target`, is_dir: true, is_ignored: true },
                { name: 'node_modules', path: `${reqPath}/node_modules`, is_dir: true, is_ignored: true },
                { name: 'Cargo.toml', path: `${reqPath}/Cargo.toml`, is_dir: false, is_ignored: false },
                { name: 'README.md', path: `${reqPath}/README.md`, is_dir: false, is_ignored: false },
                { name: 'package.json', path: `${reqPath}/package.json`, is_dir: false, is_ignored: false },
              ],
              dirs: ['crates', 'webui', 'docs', 'target', 'node_modules'],
              files: ['Cargo.toml', 'README.md', 'package.json'],
            });
          }
        }

        // FS Stat（编辑器前台标签的磁盘新鲜度轮询）
        if (pathname === '/fs/stat') {
          const filePath = parsedUrl.searchParams.get('path') || '';
          try {
            const workspaceRoot = pathMod.resolve(__dirname, '..');
            let absPath = pathMod.isAbsolute(filePath)
              ? filePath
              : pathMod.resolve(workspaceRoot, filePath.replace(/^\.\//, ''));
            if (!fs.existsSync(absPath)) {
              const fallbackPath = pathMod.resolve(process.cwd(), filePath.replace(/^\.\//, ''));
              if (fs.existsSync(fallbackPath)) {
                absPath = fallbackPath;
              }
            }
            const stat = await fsPromises.stat(absPath);
            return sendJson({
              path: absPath.replace(/\\/g, '/'),
              exists: true,
              is_file: stat.isFile(),
              size: stat.size,
              modified_ms: Math.round(stat.mtimeMs),
            });
          } catch {
            return sendJson({ path: filePath, exists: false, is_file: false, size: 0, modified_ms: null });
          }
        }

        // FS Read File
        if (pathname === '/fs/read' || pathname === '/fs/file') {
          const filePath = parsedUrl.searchParams.get('path') || '';
          try {
            const workspaceRoot = pathMod.resolve(__dirname, '..');
            let absPath = pathMod.isAbsolute(filePath)
              ? filePath
              : pathMod.resolve(workspaceRoot, filePath.replace(/^\.\//, ''));
            if (!fs.existsSync(absPath)) {
              const fallbackPath = pathMod.resolve(process.cwd(), filePath.replace(/^\.\//, ''));
              if (fs.existsSync(fallbackPath)) {
                absPath = fallbackPath;
              }
            }
            const content = await fsPromises.readFile(absPath, 'utf8');
            const stat = await fsPromises.stat(absPath).catch(() => null);
            return sendJson({
              path: absPath.replace(/\\/g, '/'),
              content,
              success: true,
              size: stat?.size ?? content.length,
              modified_ms: stat ? Math.round(stat.mtimeMs) : null,
            });
          } catch (e: any) {
            return sendJson({
              path: filePath,
              content: `# ${filePath}\n\n*这是 JeikCode 高性能代码编辑器 Mock 内容演示*\n\n\`\`\`rust\nfn main() {\n    println!("Hello from JeikCode Explorer!");\n}\n\`\`\`\n`,
              success: true,
            });
          }
        }

        // FS Write File
        if (pathname === '/fs/write') {
          const body = await readJsonBody(req);
          try {
            const absPath = pathMod.resolve(body.path);
            await fsPromises.writeFile(absPath, body.content ?? '', 'utf8');
            return sendJson({ success: true, message: 'File saved successfully' });
          } catch (e: any) {
            return sendJson({ success: true, message: 'File saved (mock)' });
          }
        }

        // FS Actions (create, rename, delete)
        if (pathname === '/fs/action') {
          const body = await readJsonBody(req);
          const action = body.action;
          const targetPath = body.path ? pathMod.resolve(body.path) : '';
          try {
            if (action === 'delete') {
              if (targetPath && fs.existsSync(targetPath)) {
                await fsPromises.rm(targetPath, { recursive: true, force: true });
              }
            } else if (action === 'rename') {
              const newName = (body.new_name || '').trim();
              if (targetPath && newName) {
                const parentDir = pathMod.dirname(targetPath);
                const newPath = pathMod.join(parentDir, newName);
                await fsPromises.rename(targetPath, newPath);
              }
            }
            return sendJson({ success: true, message: `Action ${body.action || ''} completed` });
          } catch (err: any) {
            res.statusCode = 500;
            return sendJson({ success: false, error: err?.message || String(err) });
          }
        }

        // FS Reveal in explorer (真正调用操作系统的资源管理器并高亮选中文件)
        if (pathname === '/fs/reveal') {
          const body = await readJsonBody(req);
          const rawPath = body.path || '';
          if (rawPath) {
            try {
              const absP = pathMod.resolve(rawPath);
              if (fs.existsSync(absP)) {
                const { spawn } = await import('node:child_process');
                if (process.platform === 'win32') {
                  const stat = fs.statSync(absP);
                  if (stat.isDirectory()) {
                    spawn('explorer.exe', [absP], { detached: true, stdio: 'ignore' });
                  } else {
                    spawn('explorer.exe', [`/select,${absP}`], { detached: true, stdio: 'ignore' });
                  }
                } else if (process.platform === 'darwin') {
                  spawn('open', ['-R', absP], { detached: true, stdio: 'ignore' });
                } else {
                  spawn('xdg-open', [absP], { detached: true, stdio: 'ignore' });
                }
              }
            } catch (err) {
              console.warn('[mock-server] Failed to reveal in explorer:', err);
            }
          }
          return sendJson({ success: true, message: `Revealed in explorer: ${rawPath}` });
        }

        // FS Raw binary / image stream
        if (pathname === '/fs/raw') {
          const filePath = parsedUrl.searchParams.get('path') || '';
          try {
            const workspaceRoot = pathMod.resolve(__dirname, '..');
            let absPath = pathMod.isAbsolute(filePath)
              ? filePath
              : pathMod.resolve(workspaceRoot, filePath.replace(/^\.\//, ''));
            if (!fs.existsSync(absPath)) {
              const fallbackPath = pathMod.resolve(process.cwd(), filePath.replace(/^\.\//, ''));
              if (fs.existsSync(fallbackPath)) {
                absPath = fallbackPath;
              }
            }
            if (!fs.existsSync(absPath)) {
              res.statusCode = 404;
              return res.end('File not found');
            }
            const ext = (pathMod.extname(absPath) || '').toLowerCase();
            const mimeMap: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
              '.svg': 'image/svg+xml',
              '.ico': 'image/x-icon',
              '.bmp': 'image/bmp',
              '.avif': 'image/avif',
              '.pdf': 'application/pdf',
              '.mp4': 'video/mp4',
              '.mp3': 'audio/mpeg',
            };
            const mime = mimeMap[ext] || 'application/octet-stream';
            res.statusCode = 200;
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
            const stream = fs.createReadStream(absPath);
            return stream.pipe(res);
          } catch (e: any) {
            res.statusCode = 500;
            return res.end(e?.message || 'Read error');
          }
        }

        // FS Open with OS default application
        if (pathname === '/fs/open') {
          const body = await readJsonBody(req);
          const rawPath = body.path || '';
          if (rawPath) {
            try {
              const absP = pathMod.resolve(rawPath);
              if (fs.existsSync(absP)) {
                const { spawn } = await import('node:child_process');
                if (process.platform === 'win32') {
                  spawn('cmd.exe', ['/c', 'start', '""', absP], { detached: true, stdio: 'ignore' });
                } else if (process.platform === 'darwin') {
                  spawn('open', [absP], { detached: true, stdio: 'ignore' });
                } else {
                  spawn('xdg-open', [absP], { detached: true, stdio: 'ignore' });
                }
                return sendJson({ success: true });
              }
            } catch (err: any) {
              return sendJson({ success: false, error: err?.message || String(err) }, 500);
            }
          }
          return sendJson({ success: false, error: 'Path not found' }, 404);
        }

        // FS Locate (File & Directory name / path locate)
        if (pathname === '/fs/locate') {
          const rawQ = (parsedUrl.searchParams.get('q') || '').trim().replace(/^['"`]|['"`]$/g, '');
          const reqPath = parsedUrl.searchParams.get('path') || process.cwd();
          let baseDir = pathMod.resolve(reqPath);
          if (!parsedUrl.searchParams.get('path') && (baseDir.endsWith('/webui') || baseDir.endsWith('\\webui'))) {
            baseDir = pathMod.resolve(baseDir, '..');
          }
          const normBase = baseDir.replace(/\\/g, '/');
          const lowerQ = rawQ.replace(/\\/g, '/').toLowerCase();
          const isPathQuery = lowerQ.includes('/');

          if (!rawQ || !fs.existsSync(baseDir)) {
            return sendJson({ query: rawQ, results: [] });
          }

          const results: any[] = [];

          // 1. 优先检查直接命中的绝对或相对路径
          const directCand = pathMod.isAbsolute(rawQ) ? rawQ : pathMod.resolve(baseDir, rawQ.replace(/^\.\//, ''));
          if (fs.existsSync(directCand)) {
            try {
              const stat = fs.statSync(directCand);
              const isDir = stat.isDirectory();
              const normPath = directCand.replace(/\\/g, '/');
              const rel = normPath.toLowerCase().startsWith(normBase.toLowerCase())
                ? normPath.slice(normBase.length).replace(/^\/+/, '')
                : normPath;
              results.push({
                name: pathMod.basename(directCand),
                path: normPath,
                rel_path: rel || pathMod.basename(directCand),
                is_dir: isDir,
              });
            } catch {}
          }

          // 2. 深度递归遍历全量文件与目录（排除 .git, node_modules, target, dist 等）
          const walk = (currDir: string, depth = 0) => {
            if (depth > 16 || results.length >= 150) return;
            let entries: any[] = [];
            try {
              entries = fs.readdirSync(currDir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const entry of entries) {
              const name = entry.name;
              if (
                name === '.git' ||
                name === 'node_modules' ||
                name === 'target' ||
                name === 'dist' ||
                name === '.cargo' ||
                name === '.idea' ||
                name === '.vscode' ||
                name === '.vite'
              ) {
                continue;
              }
              const isDir = entry.isDirectory();
              const fullP = pathMod.join(currDir, name).replace(/\\/g, '/');
              const rel = fullP.toLowerCase().startsWith(normBase.toLowerCase())
                ? fullP.slice(normBase.length).replace(/^\/+/, '')
                : fullP;

              const lowerName = name.toLowerCase();
              const lowerRel = rel.toLowerCase();

              const isHit = isPathQuery
                ? lowerRel.includes(lowerQ)
                : lowerName.includes(lowerQ) || lowerRel.includes(lowerQ);

              if (isHit && !results.some((r) => r.path.toLowerCase() === fullP.toLowerCase())) {
                results.push({
                  name,
                  path: fullP,
                  rel_path: rel,
                  is_dir: isDir,
                });
                if (results.length >= 150) return;
              }

              if (isDir) {
                walk(pathMod.join(currDir, name), depth + 1);
              }
            }
          };

          walk(baseDir, 0);

          // 排序：精准相对路径匹配最高，其次名称精准匹配，其次前缀匹配，浅层路径优先
          results.sort((a, b) => {
            const aExactRel = a.rel_path.toLowerCase() === lowerQ;
            const bExactRel = b.rel_path.toLowerCase() === lowerQ;
            if (aExactRel !== bExactRel) return bExactRel ? 1 : -1;

            const aExact = a.name.toLowerCase() === lowerQ;
            const bExact = b.name.toLowerCase() === lowerQ;
            if (aExact !== bExact) return bExact ? 1 : -1;

            const aStarts = a.name.toLowerCase().startsWith(lowerQ);
            const bStarts = b.name.toLowerCase().startsWith(lowerQ);
            if (aStarts !== bStarts) return bStarts ? 1 : -1;

            const aRelStarts = a.rel_path.toLowerCase().startsWith(lowerQ);
            const bRelStarts = b.rel_path.toLowerCase().startsWith(lowerQ);
            if (aRelStarts !== bRelStarts) return bRelStarts ? 1 : -1;

            if (a.rel_path.length !== b.rel_path.length) {
              return a.rel_path.length - b.rel_path.length;
            }
            return a.name.length - b.name.length;
          });

          return sendJson({
            query: rawQ,
            results,
          });
        }

        // FS Search & Replace
        if (pathname === '/fs/search') {
          const q = parsedUrl.searchParams.get('q') || '';
          return sendJson({
            query: q,
            results: [
              {
                file: 'webui/src/components/GitPanel.tsx',
                line: 820,
                content: `const handleFullRefresh = useCallback(async () => { ... });`,
                matches: [[6, 6 + q.length]],
              },
              {
                file: 'webui/src/lib/gitStore.ts',
                line: 350,
                content: `public async triggerAutoFetch(cwd, options) { ... }`,
                matches: [[13, 13 + q.length]],
              },
              {
                file: 'README.md',
                line: 12,
                content: `JeikCode: Extreme KV-Cache AI Coding Agent`,
                matches: [[0, q.length]],
              },
            ],
          });
        }

        // ==================== TERMINAL REAL PERSISTENT PTY / PROCESS API ====================
        if (pathname === '/terminal/list') {
          // 终端是全局常驻后台进程，无论当前会话处于何种目录或参数，所有存活的 PTY 会话绝不丢弃
          const list = Array.from(mockTerminalStore.values())
            .map((t) => ({
              id: t.id,
              name: t.name,
              cwd: t.cwd,
              shell: t.shell,
              history: [],
              timestamp: t.timestamp,
            }));
          const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
          return sendJson({ success: true, terminals: list, platform });
        }

        if (pathname === '/terminal/create') {
          const body = await readJsonBody(req);
          const reqCwd = body.cwd ? pathMod.resolve(body.cwd) : process.cwd();
          const termId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const shellName = body.shell || 'powershell';
          const session = await getOrCreateTerminalSession(termId, reqCwd, shellName);
          return sendJson({
            success: true,
            terminal_id: termId,
            name: session.name,
            cwd: session.cwd,
          });
        }

        if (pathname === '/terminal/close') {
          const body = await readJsonBody(req);
          if (body.terminal_id) {
            const s = mockTerminalStore.get(body.terminal_id);
            if (s) {
              if (s.sockets) {
                for (const ws of s.sockets) {
                  try { ws.close(); } catch {}
                }
              }
              if (s.pty) {
                try {
                  process.kill(s.pty.pid);
                } catch {}
              }
            }
            mockTerminalStore.delete(body.terminal_id);
          }
          return sendJson({ success: true });
        }

        if (pathname === '/terminal/input') {
          const body = await readJsonBody(req);
          const termId = body.terminal_id;
          const input = body.input;
          const session = mockTerminalStore.get(termId);

          if (session && session.pty) {
            session.pty.write(input);
          }
          return sendJson({ success: true });
        }

        // Default fallback to next for non-mocked assets/routes
        return next();
      });
    },
  };
}
