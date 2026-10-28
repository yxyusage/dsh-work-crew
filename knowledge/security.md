# security
title: 安全底线
tags: backend, security, audit
keywords: 安全,鉴权,权限,密钥,注入,漏洞,审计
url: https://owasp.org/www-project-top-ten/
use: 用 OWASP Top 10 逐条过，别凭印象说"应该没问题"
avoid: 把校验放前端；日志里打 token；错误信息暴露内部结构

- 所有输入在服务端边界校验，白名单优先。
- 鉴权在每个入口检查，不能靠前端藏按钮。
- 密钥只从环境变量读，不进仓库、不进日志。
- 密码用 bcrypt/argon2；不要自造加密。
- 高风险改动（支付/鉴权/CI/安装器）必须人工确认。
