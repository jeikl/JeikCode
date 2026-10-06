import type { Plugin } from 'vite';

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

export function mockApiPlugin(): Plugin {
  const sessionQueues = new Map<string, any[]>();
  const runningChats = new Set<string>();
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
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        // 静态资源、HTML 页面请求与 Vite 内部代码直接放行
        if (
          url === '/' ||
          url.startsWith('/?') ||
          req.headers.accept?.includes('text/html') ||
          url.startsWith('/@') ||
          url.startsWith('/src') ||
          url.startsWith('/node_modules') ||
          url.startsWith('/assets') ||
          url.endsWith('.html') ||
          url.endsWith('.js') ||
          url.endsWith('.ts') ||
          url.endsWith('.tsx') ||
          url.endsWith('.css') ||
          url.endsWith('.svg') ||
          url.endsWith('.woff') ||
          url.endsWith('.woff2') ||
          url.endsWith('.ttf')
        ) {
          return next();
        }

        const parsedUrl = new URL(url, 'http://localhost');
        let pathname = parsedUrl.pathname;
        if (pathname.startsWith('/api')) {
          pathname = pathname.slice(4);
        }
        if (!pathname.startsWith('/')) {
          pathname = '/' + pathname;
        }

        const sendJson = (data: any, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(data));
        };

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
          return sendJson({
            branch: 'beta',
            staged: [],
            unstaged: [
              { path: 'webui/src/components/Chat.tsx', status: 'M' },
              { path: 'webui/src/styles/app.css', status: 'M' },
            ],
            untracked: [],
          });
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

        // Default fallback to next for non-mocked assets/routes
        return next();
      });
    },
  };
}
