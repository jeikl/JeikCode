import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'JeikCode',
  base: process.env.VITEPRESS_BASE || '/',
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#0284c7' }],
    ['meta', { name: 'robots', content: 'index, follow, max-image-preview:large' }],
    [
      'script',
      { id: 'theme-init' },
      `
      (function() {
        try {
          var t = localStorage.getItem('vitepress-theme-appearance');
          if (!t) {
            document.documentElement.classList.add('dark');
            localStorage.setItem('vitepress-theme-appearance', 'dark');
          }
        } catch (e) {}
      })();
      `,
    ],
    [
      'script',
      { id: 'detect-lang' },
      `
      (function() {
        try {
          var p = window.location.pathname;
          if (p === '/' || p === '/index.html') {
            var saved = localStorage.getItem('jeikcode_docs_locale');
            if (saved === 'zh') {
              window.location.replace('/zh/');
              return;
            }
            if (saved === 'en') {
              return;
            }
            var lang = (navigator.language || navigator.userLanguage || '').toLowerCase();
            if (lang.indexOf('zh') === 0) {
              window.location.replace('/zh/');
            }
          }
        } catch (e) {}
      })();
      `,
    ],
  ],

  // 共享配置（全局通用的配置）
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/jeikl/JeikCode' },
    ],
    // 本地全文搜索（支持中英文分词与界面国际化）
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: {
                buttonText: 'Search Docs',
                buttonAriaLabel: 'Search Docs',
              },
              modal: {
                noResultsText: 'No results found',
                resetButtonTitle: 'Clear query',
                footer: {
                  selectText: 'to select',
                  navigateText: 'to navigate',
                  closeText: 'to close',
                },
              },
            },
          },
          zh: {
            translations: {
              button: {
                buttonText: '搜索文档',
                buttonAriaLabel: '搜索文档',
              },
              modal: {
                noResultsText: '无法找到相关结果',
                resetButtonTitle: '清除查询条件',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭',
                },
              },
            },
          },
        },
      },
    },
  },

  // 多语言配置 (Locales)
  locales: {
    // Default locale: English. Chinese lives under /zh/.
    root: {
      label: 'English',
      lang: 'en-US',
      title: 'JeikCode | Code-Graph & Ultra-Low Cache Powered Open-Source AI Coding Agent',
      titleTemplate: ':title | JeikCode AI Coding Agent',
      description: 'JeikCode is a high-performance, Rust-powered open-source AI Coding Agent featuring CodeExplore semantic graphs, append-only KV cache protection, Git-like atomic state machines, and 9k minimal prompts.',
      head: [
        ['meta', { name: 'keywords', content: 'JeikCode, AI Coding Agent, CodeExplore, KV Cache, Prompt Caching, Rust AI Agent, autonomous programmer, open-source AI assistant' }],
        ['meta', { property: 'og:title', content: 'JeikCode | Code-Graph & Ultra-Low Cache Powered AI Coding Agent' }],
        ['meta', { property: 'og:description', content: 'Rust-powered open-source AI Coding Agent driven by CodeExplore semantic graphs and append-only KV cache protection.' }],
        ['meta', { property: 'og:type', content: 'website' }],
        ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
        ['meta', { name: 'twitter:title', content: 'JeikCode | Code-Graph & Ultra-Low Cache Powered AI Coding Agent' }],
        ['meta', { name: 'twitter:description', content: 'Rust-powered AI Coding Agent driven by CodeExplore and KV cache protection.' }],
      ],
      themeConfig: {
        siteTitle: 'JeikCode Docs',
        nav: [
          { text: 'Docs', link: '/guide/introduction' },
          { text: 'Changelog', link: 'https://github.com/jeikl/JeikCode/releases' },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            collapsed: false,
            items: [
              { text: 'Introduction', link: '/guide/introduction' },
              { text: 'Quick Installation (TUI, Desktop)', link: '/guide/installation' },
              { text: 'Quickstart', link: '/guide/getting-started' },
              { text: 'Common Commands', link: '/usage/slash-commands' },
            ],
          },
          {
            text: 'Features',
            collapsed: false,
            items: [
              { text: 'Built-in Tool Catalog', link: '/advanced/tools' },
              { text: 'CodeExplore', link: '/usage/codegraph' },
              { text: 'WebUI & Remote Access', link: '/usage/webui' },
              { text: 'API Compatibility Endpoints (OpenAI, Anthropic)', link: '/usage/api-compat' },
            ],
          },
          {
            text: 'Configuration Guide',
            collapsed: false,
            items: [
              { text: 'AI Quick Configuration', link: '/guide/configuration' },
              { text: 'Model Configuration', link: '/guide/login' },
              { text: 'Instructions & Prompts', link: '/advanced/markdown-instructions' },
              { text: 'Model Context Protocol', link: '/advanced/mcp' },
              { text: 'Skills Ecosystem', link: '/advanced/skills' },
            ],
          },
        ],
        outline: {
          level: [2, 3],
          label: 'On this page',
        },
        editLink: {
          pattern: 'https://github.com/jeikl/JeikCode/edit/main/docs-site/:path',
          text: 'Edit this page on GitHub',
        },
        footer: {
          message: 'Released under the Apache-2.0 / MIT License.',
          copyright: 'Copyright © 2026 JeikCode Contributors',
        },
        docFooter: {
          prev: 'Previous page',
          next: 'Next page',
        },
        lastUpdated: {
          text: 'Last updated',
          formatOptions: {
            dateStyle: 'short',
            timeStyle: 'medium',
          },
        },
      },
    },

    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'JeikCode | 代码图谱·极致缓存·全端协同开源 AI 编程智能体',
      titleTemplate: ':title | JeikCode 开源 AI 编程助手',
      description: 'JeikCode 是一款基于 Rust 构建的高性能开源 AI Coding Agent。以深度语义代码图谱与极致 KV 缓存保护为核心底座，具备 9k 极简提示词、类 Git 状态机并发原子保护、全端多设备协同（WebUI/TUI/桌面/移动端）与五大主流大模型协议自适应调度。',
      head: [
        ['meta', { name: 'keywords', content: 'JeikCode, AI编程助手, AI Coding Agent, 代码图谱, 极致缓存, Prompt Caching, Rust AI, 智能编程代理, Claude Code, 开源编程助手, WebUI' }],
        ['meta', { property: 'og:title', content: 'JeikCode | 代码图谱·极致缓存·全端协同开源 AI 编程智能体' }],
        ['meta', { property: 'og:description', content: '基于 Rust 的全功能开源 AI Coding Agent。代码图谱全景检索，极致 KV 缓存保护，9k极简提示词与类 Git 状态机原子编辑保护。' }],
        ['meta', { property: 'og:type', content: 'website' }],
        ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
        ['meta', { name: 'twitter:title', content: 'JeikCode | 代码图谱·极致缓存·全端协同开源 AI 编程智能体' }],
        ['meta', { name: 'twitter:description', content: '代码图谱与极致缓存驱动的开源 AI 编程助手。' }],
      ],
      themeConfig: {
        siteTitle: 'JeikCode Docs',
        nav: [
          { text: 'Docs', link: '/zh/guide/introduction' },
          { text: '更新日志', link: 'https://github.com/jeikl/JeikCode/releases' },
        ],
        sidebar: [
          {
            text: '起步指南',
            collapsed: false,
            items: [
              { text: '产品简介', link: '/zh/guide/introduction' },
              { text: '快速安装（TUI、桌面端）', link: '/zh/guide/installation' },
              { text: '快速开始', link: '/zh/guide/getting-started' },
              { text: '常用命令', link: '/zh/usage/slash-commands' },
            ],
          },
          {
            text: '特性功能',
            collapsed: false,
            items: [
              { text: '内置工具系统', link: '/zh/advanced/tools' },
              { text: '代码图谱', link: '/zh/usage/codegraph' },
              { text: 'WebUI 界面与远程访问', link: '/zh/usage/webui' },
              { text: 'API 兼容端点（OpenAI、Anthropic）', link: '/zh/usage/api-compat' },
            ],
          },
          {
            text: '配置指南',
            collapsed: false,
            items: [
              { text: 'AI快速配置', link: '/zh/guide/configuration' },
              { text: '模型配置', link: '/zh/guide/login' },
              { text: '项目指令与提示词', link: '/zh/advanced/markdown-instructions' },
              { text: '模型上下文协议', link: '/zh/advanced/mcp' },
              { text: '技能系统', link: '/zh/advanced/skills' },
            ],
          },
        ],
        outline: {
          level: [2, 3],
          label: '页面目录',
        },
        editLink: {
          pattern: 'https://github.com/jeikl/JeikCode/edit/main/docs-site/:path',
          text: '在 GitHub 上编辑此页',
        },
        footer: {
          message: 'Released under the Apache-2.0 / MIT License.',
          copyright: 'Copyright © 2026 JeikCode Contributors',
        },
        docFooter: {
          prev: '上一篇',
          next: '下一篇',
        },
        lastUpdated: {
          text: '最后更新于',
          formatOptions: {
            dateStyle: 'short',
            timeStyle: 'medium',
          },
        },
      },
    },
  },
})
