#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把本机改动追加到资料库云端 README（变更记录章节）。

用法：
  1) 追加一节变更记录（最常用）
     python deploy/sync-doc.py --heading "2026-10-11 · 一句话标题" --bullets-file notes.txt
     python deploy/sync-doc.py --heading "2026-10-11 · 标题" --bullet "第一点" --bullet "第二点"

  2) 直接透传自定义 actions.json（老块改写 / 删除等复杂编辑）
     python deploy/sync-doc.py --actions-file actions.json

  3) 只看校验不提交
     任意组合加 --dry-run

notes.txt 规则：一行一条 bullet，行首的 "- " / "* " 会自动剥掉；
行内允许写 <Mark bold>...</Mark> 做加粗。
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile

# 云端 README 节点 id（nodeId == pageId）
PAGE_ID = "c4ZCuOJDEH7SH9xqhVqNWK"
SKILL_DOC_GLOB = os.path.expanduser(
    "~/.workbuddy/plugins/cache/workbuddy-builtin/skill-library/*/doc"
)


def find_submit_script():
    """插件目录带版本号，会随升级变化，取最新一个。"""
    cands = sorted(glob.glob(os.path.join(SKILL_DOC_GLOB, "submit_doc_edit.py")))
    if not cands:
        raise SystemExit("找不到 submit_doc_edit.py，检查资料库插件是否安装")
    return cands[-1]


def esc(text):
    """保护裸 & ，避免破坏组件标签解析；<Mark> 标签由调用方自己写。"""
    return text.replace("&", "&amp;").replace("&amp;lt;", "&lt;").replace("&amp;gt;", "&gt;")


def build_blocks(heading, bullets):
    blocks = []
    if heading:
        blocks.append('<Heading level="3">\n  %s\n</Heading>' % esc(heading))
    for b in bullets:
        b = b.strip()
        if not b:
            continue
        for prefix in ("- ", "* ", "• "):
            if b.startswith(prefix):
                b = b[len(prefix):].strip()
                break
        blocks.append("<BulletedList>\n  %s\n</BulletedList>" % b)
    if not blocks:
        raise SystemExit("没有可提交的内容")
    return blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--heading", help="小节标题，形如 2026-10-11 · xxx")
    ap.add_argument("--bullet", action="append", default=[], help="一条 bullet，可重复")
    ap.add_argument("--bullets-file", help="bullet 文本文件，一行一条")
    ap.add_argument("--actions-file", help="自定义 actions.json，直接透传")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.actions_file:
        actions_path = args.actions_file
    else:
        bullets = list(args.bullet)
        if args.bullets_file:
            with open(args.bullets_file, encoding="utf-8") as f:
                bullets.extend(f.read().splitlines())
        blocks = build_blocks(args.heading, bullets)
        # insert_after(id="") == 追加到文档末尾，无需关心块 id
        actions = [{"type": "insert_after", "id": "", "content": "\n\n".join(blocks)}]
        fd, actions_path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(actions, f, ensure_ascii=False, indent=2)

    script = find_submit_script()
    cmd = [
        sys.executable,
        script,
        "--page-id",
        PAGE_ID,
        "--actions-file",
        os.path.abspath(actions_path),
    ]
    if args.dry_run:
        cmd.append("--dry-run")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (r.stdout or "").strip()
    err = (r.stderr or "").strip()
    print(out or err)
    if r.returncode != 0 or not out.startswith("KS_"):
        raise SystemExit("提交失败（空输出或异常），不要盲目重试，先回读文档确认状态")
    if not args.dry_run and args.actions_file is None:
        os.unlink(actions_path)


if __name__ == "__main__":
    main()
