import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import './custom.css'
import HeroImageWithVersion from './HeroImageWithVersion.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-image': () => h(HeroImageWithVersion),
    })
  },
}
