# observability
title: 日志与可观测性
tags: backend, ops, observability
keywords: 日志,监控,指标,告警,追踪,性能
url: https://opentelemetry.io/docs/
use: 先有日志和指标，再谈优化；出问题能定位才算做完
avoid: 只打 console.log；日志没有请求 id；告警不可行动

- 结构化日志：时间、级别、请求 id、耗时、结果。
- 关键路径埋指标：QPS、错误率、P99 延迟。
- 告警必须能对应一个动作，否则就是噪音。
- 慢查询和慢外部调用要单独记录耗时。
