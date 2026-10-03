<script setup lang="ts">
const version = 'v7.1.41'
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
    margin-top: 120px !important;
  }
}

.hero-main-logo {
  max-width: 320px;
  max-height: 320px;
  width: 100%;
  height: auto;
  filter: drop-shadow(0 0 45px rgba(62, 175, 124, 0.25));
  transition: transform 0.35s ease;
}

@media (max-width: 767px) {
  .hero-main-logo {
    max-width: min(220px, 70vw);
    max-height: min(220px, 70vw);
  }
}

.hero-main-logo:hover {
  transform: scale(1.02);
}

.hero-version-tag-wrapper {
  margin-top: 10px;
  margin-bottom: 20px;
  display: flex;
  justify-content: center;
}

.hero-version-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
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
  box-shadow: 0 6px 20px rgba(62, 175, 124, 0.3);
}

.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--vp-c-brand-1);
  box-shadow: 0 0 8px var(--vp-c-brand-1);
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
