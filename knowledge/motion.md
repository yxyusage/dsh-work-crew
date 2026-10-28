# motion
title: 动效（选项切换/展开收起）
tags: frontend, motion, animation
keywords: 动画,动效,过渡,切换,展开,交互
url: https://github.com/zhoulinhua0-star/smooth-option-switcher
use: 切换类交互用共享元素过渡（指示块滑过去），不要整块淡出再淡入
avoid: 每个元素都加 transition；duration 800ms 以上；用 left/top 做位移

- 时长：状态反馈 120–200ms，面板展开 240–360ms，页面级过渡不超过 400ms。
- 缓动：进场 `cubic-bezier(.2,0,0,1)`，退场 `cubic-bezier(.4,0,1,1)`；不要用 linear。
- 只动 `transform` 和 `opacity`；动 `width/left/top` 会掉帧。
- 切换选项卡：用一个滑块元素 + transform 位移，比每项单独改背景干净。
- 必须有 `prefers-reduced-motion: reduce` 降级：直接跳到终态。
- 动画是为了让人知道"状态变了"，不是为了炫；看不出来就别加。
