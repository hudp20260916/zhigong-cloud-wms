/**
 * 品牌名的唯一来源。
 *
 * 之前「啊平智能」被硬编码散落在 MainLayout（2 处）、LoginPage（1 处）、
 * index.html（1 处），改名字要挨个找，漏一处就出现「这边变了那边没变」。
 * 现在所有界面文案一律从这里取，改品牌名只改这一行。
 *
 * 注意：打印抬头的公司名是另一套，存在数据库 app_settings.company.name，
 * 由用户在「系统参数 → 企业信息 → 公司名称」里维护，不走这里。
 */
export const BRAND_NAME = '啊平智能';

export const BRAND_SUBTITLE = '小家电生产组装进销存管理系统';

export const BRAND_FULL_TITLE = `${BRAND_NAME} - ${BRAND_SUBTITLE}`;
