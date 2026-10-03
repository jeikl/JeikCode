import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'JeikCode',
  base: '/',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
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
          en: {
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
        },
      },
    },
  },

  // 多语言配置 (Locales)
  locales: {
    // 默认根语言：简体中文
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'JeikCode',
      description: 'JeikCode 官方使用教程与开发指南',
      themeConfig: {
        siteTitle: 'JeikCode Docs',
        nav: [
          { text: '更新日志', link: 'https://github.com/jeikl/JeikCode/releases' },
        ],
        sidebar: [
          {
            text: '起步指南',
            collapsed: false,
            items: [
              { text: '产品简介', link: '/guide/introduction' },
              { text: '快速安装', link: '/guide/installation' },
              { text: '快速开始', link: '/guide/getting-started' },
              { text: '常用命令', link: '/usage/slash-commands' },
            ],
          },
          {
            text: 'Webui、桌面端、远程访问',
            collapsed: false,
            items: [
              { text: 'WebUI 界面与远程访问', link: '/usage/webui' },
              { text: '桌面端应用 (Tauri)', link: '/deploy/desktop' },
              { text: 'API 兼容端点', link: '/usage/api-compat' },
            ],
          },
          {
            text: '配置指南',
            collapsed: false,
            items: [
              { text: 'AI快速配置', link: '/guide/configuration' },
              { text: '模型配置', link: '/guide/login' },
              { text: '项目指令与提示词 (Markdown)', link: '/advanced/markdown-instructions' },
              { text: 'MCP (模型上下文协议)', link: '/advanced/mcp' },
              { text: 'Skills 技能系统', link: '/advanced/skills' },
              { text: '内置工具系统', link: '/advanced/tools' },
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

    // 英文语言包：English
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'JeikCode',
      description: 'Next-Generation Full-Featured AI Coding Agent',
      themeConfig: {
        siteTitle: 'JeikCode Docs',
        nav: [
          { text: 'Changelog', link: 'https://github.com/jeikl/JeikCode/releases' },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            collapsed: false,
            items: [
              { text: 'Introduction', link: '/en/guide/introduction' },
              { text: 'Installation', link: '/en/guide/installation' },
              { text: 'Quickstart', link: '/en/guide/getting-started' },
              { text: 'Common Commands', link: '/en/usage/slash-commands' },
            ],
          },
          {
            text: 'WebUI, Desktop & Remote Access',
            collapsed: false,
            items: [
              { text: 'WebUI & Remote Access', link: '/en/usage/webui' },
              { text: 'Desktop App (Tauri)', link: '/en/deploy/desktop' },
              { text: 'API Compatibility Endpoints', link: '/en/usage/api-compat' },
            ],
          },
          {
            text: 'Configuration Guide',
            collapsed: false,
            items: [
              { text: 'AI Quick Configuration', link: '/en/guide/configuration' },
              { text: 'Model Configuration', link: '/en/guide/login' },
              { text: 'Instructions & Prompts (Markdown)', link: '/en/advanced/markdown-instructions' },
              { text: 'MCP (Model Context Protocol)', link: '/en/advanced/mcp' },
              { text: 'Skills Ecosystem', link: '/en/advanced/skills' },
              { text: 'Built-in Tool Catalog', link: '/en/advanced/tools' },
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
  },
})
