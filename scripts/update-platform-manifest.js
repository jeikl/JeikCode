#!/usr/bin/env node
/**
 * 已停用。
 *
 * 旧实现按平台各向 main 推一条
 * `chore(release): 自动同步 <tag> [<arch>] 校验清单`，一次发版六条提交。
 * 标签流水线改为六个二进制都齐之后调用 scripts/publish-release.js，只提交一次。
 */
'use strict';

console.error('update-platform-manifest.js 已停用，避免每个架构各提交一次。');
console.error('请使用: node scripts/publish-release.js --tag <tag> --dist dist');
process.exit(1);
