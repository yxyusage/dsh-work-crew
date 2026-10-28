# web-performance
title: 网页性能
tags: frontend, performance
keywords: 性能,加载,卡顿,首屏,LCP,优化
url: https://hpbn.co/
use: 先量再优化：LCP、INP、CLS 三个数达标再谈别的
avoid: 无脑懒加载导致布局跳动；第三方脚本不设超时

- 首屏关键资源内联或预加载，非关键延后。
- 图片给宽高比，避免 CLS；能用 CSS 就不用图。
- 第三方脚本按需加载并设超时，失败要能降级。
- 动效只用 transform/opacity，避免触发布局。
