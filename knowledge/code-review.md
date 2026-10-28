# code-review
title: 代码评审清单
tags: review, backend, quality
keywords: 评审,代码审查,review,PR,合并
url: https://google.github.io/eng-practices/review/
use: 评审只看五件事：正确性、可读性、一致性、测试、风险
avoid: 只挑风格；一条评论塞十个问题；说"我觉得不行"却不给替代方案

- 小 PR：一次只解决一件事，改动超过 400 行就该拆。
- 评论分两级：「必须改」和「建议」，别让人猜。
- 先看接口、错误路径、边界条件，再看实现细节。
- 每条意见指到 `文件:行号`，给替代写法。
