# sql-data
title: 数据库与查询
tags: backend, database, sql, data
keywords: 数据库,SQL,索引,查询,表,迁移
url: https://use-the-index-luke.com/
use: 索引按查询建，不按字段建；先看执行计划再动手
avoid: 在索引列上套函数；`SELECT *`；没有分页的全表扫描

- 复合索引列序：等值条件在前、范围条件在后。
- 改索引前先 `EXPLAIN`，看的是执行计划不是感觉。
- 迁移要可回滚；大表加列注意锁表时间。
- 字段默认值、非空、唯一约束在库层面定，不要只靠代码。
