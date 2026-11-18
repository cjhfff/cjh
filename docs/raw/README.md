# raw

从 Alma 0.4.708（Windows）服务端打包文件中用脚本抽出来的名称清单，只用来查细节。

- routes.txt：HTTP 路由（方法 + 路径），按前缀分组。其中 /assistants、/audio、/chat、/responses 这类不带 /api 前缀的，是打包进来的 OpenAI SDK 内部路径，不是 Alma 自己的路由，可以忽略
- tables.txt：drizzle 声明的 40 张表的字段名和约束。数据库里实际有 90 张表，剩下的是原生 SQL 建的（FTS5、sqlite-vec、activity_*、team_*、crystal_* 等）
