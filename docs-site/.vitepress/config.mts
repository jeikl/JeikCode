import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'JeikCode',
  base: '/',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
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
      title: 'JeikCode',
      description: 'Next-Generation Full-Featured AI Coding Agent',
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
              { text: 'Installation', link: '/guide/installation' },
              { text: 'Quickstart', link: '/guide/getting-started' },
              { text: 'Common Commands', link: '/usage/slash-commands' },
            ],
          },
          {
            text: 'WebUI, Desktop & Remote Access',
            collapsed: false,
            items: [
              { text: 'WebUI & Remote Access', link: '/usage/webui' },
              { text: 'Desktop App (Tauri)', link: '/deploy/desktop' },
              { text: 'API Compatibility Endpoints', link: '/usage/api-compat' },
            ],
          },
          {
            text: 'Configuration Guide',
            collapsed: false,
            items: [
              { text: 'AI Quick Configuration', link: '/guide/configuration' },
              { text: 'Model Configuration', link: '/guide/login' },
              { text: 'Instructions & Prompts (Markdown)', link: '/advanced/markdown-instructions' },
              { text: 'MCP (Model Context Protocol)', link: '/advanced/mcp' },
              { text: 'Skills Ecosystem', link: '/advanced/skills' },
              { text: 'Built-in Tool Catalog', link: '/advanced/tools' },
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
      title: 'JeikCode',
      description: 'JeikCode 官方使用教程与开发指南',
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
              { text: '快速安装', link: '/zh/guide/installation' },
              { text: '快速开始', link: '/zh/guide/getting-started' },
              { text: '常用命令', link: '/zh/usage/slash-commands' },
            ],
          },
          {
            text: 'Webui、桌面端、远程访问',
            collapsed: false,
            items: [
              { text: 'WebUI 界面与远程访问', link: '/zh/usage/webui' },
              { text: '桌面端应用 (Tauri)', link: '/zh/deploy/desktop' },
              { text: 'API 兼容端点', link: '/zh/usage/api-compat' },
            ],
          },
          {
            text: '配置指南',
            collapsed: false,
            items: [
              { text: 'AI快速配置', link: '/zh/guide/configuration' },
              { text: '模型配置', link: '/zh/guide/login' },
              { text: '项目指令与提示词 (Markdown)', link: '/zh/advanced/markdown-instructions' },
              { text: 'MCP (模型上下文协议)', link: '/zh/advanced/mcp' },
              { text: 'Skills 技能系统', link: '/zh/advanced/skills' },
              { text: '内置工具系统', link: '/zh/advanced/tools' },
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
