import { pinyin } from 'pinyin-pro';

/**
 * 拼音首字母，用于主产品/物料快速检索（需求 3.4.2）。
 * 档案保存时自动计算并落库，同时允许人工修正。
 */
export function pinyinInitials(text: string): string {
  if (!text) return '';
  try {
    return pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' })
      .join('')
      .replace(/[^a-zA-Z]/g, '')
      .toUpperCase();
  } catch {
    return '';
  }
}

/**
 * 档案检索：命中编码 / 名称 / 拼音首字母任一即匹配。
 * 无匹配时上层提示「未找到匹配主产品」，绝不自动建档（需求 5）。
 */
export function matchesKeyword(
  row: { code?: string; name?: string; pinyin?: string; spec?: string },
  keyword: string,
): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  const hay = [row.code, row.name, row.pinyin, row.spec]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(kw);
}
