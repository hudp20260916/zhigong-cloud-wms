-- 成品档案 · 分类字段（2026-10-13）
--
-- 背景：物料档案早就有 category 列（001_schema.sql），成品档案却没有，
-- 产品档案页与物料档案页口径不一致。本次补齐，与 materials.category 对齐。
--
-- 设计要点：
--  - category 选填，允许 NULL / 空串，不加 NOT NULL，不影响存量数据。
--  - 不建索引：本字段仅用于列表展示与档案填写，不参与检索条件（keyword 走
--    code/name/pinyin/spec 的 LIKE），无索引需求。
--
-- 幂等说明：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，
-- 靠迁移框架「文件顺序 + _migrations 表只跑一次」保证幂等，
-- 框架不额外插补列层（010 迁移曾因此踩坑，见 db/index.ts 注释）。

ALTER TABLE products ADD COLUMN category TEXT;