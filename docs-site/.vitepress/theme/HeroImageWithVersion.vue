<script setup lang="ts">
import { ref, onMounted } from 'vue'

// 两个独立的兜底版本号：一个正式版，一个 beta 版
const stableVersion = ref('v7.2.8')
const betaVersion = ref('v7.3.2-beta.1')

onMounted(async () => {
  try {
    // 优先从本站 Cloudflare 边缘缓存接口获取最新全量发布列表（零限流、毫秒响应）
    const res = await fetch('https://jeikcode.top/api/releases')
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data)) {
        // 分别解析出最新的正式版和最新的 Beta 预发布版
        const stable = data.find((r: any) => !r.prerelease)
        if (stable?.tag_name) {
          stableVersion.value = stable.tag_name.startsWith('v') ? stable.tag_name : `v${stable.tag_name}`
        }
        const beta = data.find((r: any) => r.prerelease)
        if (beta?.tag_name) {
          betaVersion.value = beta.tag_name.startsWith('v') ? beta.tag_name : `v${beta.tag_name}`
        }
      }
    }
  } catch {
    // 离线或异常时静默降级为构建期确定的最新静态版本号
  }
})
</script>

<template>
  <div class="hero-image-box">
    <img src="/logo.svg" alt="JeikCode Logo" class="hero-main-logo" />
    <div class="hero-version-tag-wrapper">
      <!-- 1. 正式稳定版徽章 -->
      <a
        :href="`https://github.com/jeikl/JeikCode/releases/tag/${stableVersion}`"
        target="_blank"
        rel="noopener noreferrer"
        class="hero-version-badge badge-stable"
        title="查看最新正式版发布说明"
      >
        <span class="badge-dot dot-stable"></span>
        <span class="badge-label">Stable</span>
        <span class="badge-ver">{{ stableVersion }}</span>
      </a>

      <!-- 2. Beta 预览版徽章 -->
      <a
        v-if="betaVersion"
        :href="`https://github.com/jeikl/JeikCode/releases/tag/${betaVersion}`"
        target="_blank"
        rel="noopener noreferrer"
        class="hero-version-badge badge-beta"
        title="查看最新 Beta 预览版发布说明"
      >
        <span class="badge-dot dot-beta"></span>
        <span class="badge-label">Beta</span>
        <span class="badge-ver">{{ betaVersion }}</span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.hero-image-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
}

@media (max-width: 959px) {
  .hero-image-box {
    margin-top: 0 !important;
  }
}

.hero-main-logo {
  max-width: 320px;
  max-height: 320px;
  width: 100%;
  height: auto;
  filter: drop-shadow(0 0 45px rgba(56, 189, 248, 0.4));
  transition: transform 0.35s ease;
}

@media (max-width: 767px) {
  .hero-main-logo {
    max-width: 135px !important;
    max-height: 135px !important;
    filter: drop-shadow(0 0 24px rgba(56, 189, 248, 0.35)) !important;
  }
}

.hero-main-logo:hover {
  transform: scale(1.02);
}

.hero-version-tag-wrapper {
  margin-top: 10px;
  margin-bottom: 16px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.hero-version-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-1);
  text-decoration: none;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.hero-version-badge:hover {
  transform: translateY(-2px);
}

.badge-stable:hover {
  border-color: #00f2fe;
  color: #00f2fe;
  box-shadow: 0 6px 20px rgba(0, 242, 254, 0.35);
}

.badge-beta:hover {
  border-color: #f59e0b;
  color: #f59e0b;
  box-shadow: 0 6px 20px rgba(245, 158, 11, 0.35);
}

.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.dot-stable {
  background-color: #00f2fe;
  box-shadow: 0 0 8px #00f2fe;
  animation: pulseStable 2s infinite ease-in-out;
}

.dot-beta {
  background-color: #f59e0b;
  box-shadow: 0 0 8px #f59e0b;
  animation: pulseBeta 2s infinite ease-in-out;
}

@keyframes pulseStable {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.85); }
}

@keyframes pulseBeta {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.85); }
}

.badge-label {
  font-size: 11px;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--vp-c-text-2);
  letter-spacing: 0.5px;
}

.badge-ver {
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.badge-beta .badge-ver {
  color: #f59e0b;
}
</style>
