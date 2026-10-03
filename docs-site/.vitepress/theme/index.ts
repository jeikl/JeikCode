import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import type { EnhanceAppContext } from 'vitepress'
import './custom.css'
import HeroImageWithVersion from './HeroImageWithVersion.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-image': () => h(HeroImageWithVersion),
    })
  },
  enhanceApp({ router }: EnhanceAppContext) {
    if (typeof window !== 'undefined') {
      router.onAfterRouteChanged = (to) => {
        try {
          if (to.startsWith('/zh/') || to === '/zh') {
            localStorage.setItem('jeikcode_docs_locale', 'zh')
          } else {
            localStorage.setItem('jeikcode_docs_locale', 'en')
          }
        } catch (e) {}
      }
    }
  },
}
