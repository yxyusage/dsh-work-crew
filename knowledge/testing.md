# testing
title: 测试策略
tags: backend, testing, qa
keywords: 测试,单测,集成,回归,用例
url: https://martinfowler.com/articles/practical-test-pyramid.html
use: 单元多、集成少、端到端极少；测试金字塔不是口号
avoid: 只写端到端；测试依赖真实网络和时间；断言实现细节

- 每个 bug 修复配一条回归测试，先红后绿。
- 测试要独立、可重复、快；失败信息要能直接定位。
- 断言行为而不是实现；不 mock 被测对象自己。
