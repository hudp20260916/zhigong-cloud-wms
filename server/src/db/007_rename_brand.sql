-- 品牌更名：智工云仓 / 阿平云仓 -> 啊平智能
-- 只纠正仍为旧名（或为空）的记录，避免覆盖用户自己改过的其他公司名
UPDATE app_settings
   SET value = '啊平智能'
 WHERE key = 'company.name'
   AND (value IS NULL OR value = '' OR value IN ('智工云仓', '阿平云仓'));
