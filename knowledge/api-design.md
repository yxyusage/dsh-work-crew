# api-design
title: 接口设计
tags: backend, api, contract
keywords: 接口,API,后端,请求,响应,错误码,契约
url: https://google.aip.dev/
use: 先定资源名和错误格式，再写实现；错误统一用 problem+json
avoid: 每个接口返回结构都不一样；用 200 包着错误返回；动词命名（/getUser）

- 资源用名词复数：`/users/{id}/orders`，不用动词开头。
- 错误统一 RFC 9457：`type / title / status / detail`，业务码放扩展字段。
- 写操作要幂等：客户端带 `Idempotency-Key`，服务端记住结果。
- 列表分页用 `pageSize + pageToken`，不要深翻 offset。
- 版本策略先定：路径 `/v1` 或 header，不要事后补。
