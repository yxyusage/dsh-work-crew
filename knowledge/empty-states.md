# empty-states
title: 空状态 / 加载 / 错误
tags: frontend, ui, state
keywords: 空状态,加载,错误,占位,首次,empty
url: https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states
use: 空状态回答三件事：为什么空、现在能做什么、做完会得到什么
avoid: 只写「暂无数据」；用一个灰色插画占满半屏

- 空状态 = 一句说明 + 一个主操作 +（可选）一个小示例。
- 首次进入和"筛选后为空"要分开写文案：一个是引导，一个是提示换个条件。
- 加载超过 400ms 用骨架屏；不要用转圈配"加载中…"文字。
- 错误要给原因和下一步（重试 / 换个方式），不能只报错。
- 占位内容要长得像真实结果（一两行样例），让人知道能得到什么。
