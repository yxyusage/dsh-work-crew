# backend-patterns
title: 服务拆分与结构
tags: backend, architecture, pattern
keywords: 后端,架构,微服务,服务,部署,队列
url: https://microservices.io/patterns/index.html
use: 先判断是不是分布式问题，再套模式；单体优先，拆是手段不是目标
avoid: 上来就微服务；无脑 CQRS / 事件溯源；为了"先进"拆服务

- 12-Factor：配置进环境变量、进程无状态、日志当事件流。
- 拆服务的条件：独立部署 / 独立伸缩 / 独立团队，缺一条就别拆。
- 跨服务一致性先考虑 outbox + 幂等消费，不要上分布式事务。
- 每个外部调用都要有超时、重试上限和熔断。
