# frontend-ui
title: 界面结构与组件
tags: frontend, ui, component, form, layout
keywords: 页面,前端,组件,表单,布局,界面,按钮,输入框,卡片
url: https://ui.shadcn.com/docs/ai-elements
use: 抄结构不抄皮肤：先看它怎么组织信息层级和状态，再定自己的视觉
gates: viewport
avoid: 直接把 demo 的样式贴过来；组件有了、状态没做

- 先定正文宽度（约 65 字符 ≈ 640px），再排栅格；不要先画 12 栏再塞内容。
- 表单：label 在上、必填有标记、错误就地显示在字段下、禁用态要能看出来。
- 每个交互元素都要有四种态：默认 / hover / focus-visible / disabled。
- 按钮分主次：一屏只允许一个主按钮；次按钮用描边或纯文字。
- 长内容分块：标题 + 一句引导 + 内容；不要连续三段以上没有小标题。
- 状态：空、加载（骨架或明确文案）、错误（可重试）、成功（给下一步）。
- 键盘 Tab 顺序 = 视觉顺序；focus 环不要用 `outline: none` 删掉。
