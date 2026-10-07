<script setup lang="ts">
import { ref, onMounted } from 'vue'

const version = ref('v7.2.1-beta.1')

onMounted(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/jeikl/JeikCode/releases/latest')
    if (res.ok) {
      const data = await res.json()
      if (data && typeof data.tag_name === 'string' && data.tag_name) {
        version.value = data.tag_name.startsWith('v') ? data.tag_name : `v${data.tag_name}`
      }
    }
  } catch {
    // 离线或 API 限流时静默降级为构建期确定的最新静态版本号
  }
})
</script>

<template>
  <div class="hero-image-box">
    <img src="/logo.svg" alt="JeikCode Logo" class="hero-main-logo" />
    <div class="hero-version-tag-wrapper">
      <a
        href="https://github.com/jeikl/JeikCode/releases"
        target="_blank"
        rel="noopener noreferrer"
        class="hero-version-badge"
        title="查看最新版本发布说明"
      >
        <span class="badge-dot"></span>
        <span class="badge-label">Latest</span>
        <span class="badge-ver">{{ version }}</span>
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
  margin-top: 8px;
  margin-bottom: 16px;
  display: flex;
  justify-content: center;
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
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-default-soft);
  color: var(--vp-c-brand-1);
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(56, 189, 248, 0.4);
}

.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: #00f2fe;
  box-shadow: 0 0 8px #00f2fe;
  animation: pulseDot 2s infinite ease-in-out;
}

@keyframes pulseDot {
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
</style>
