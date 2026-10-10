# 啊平智能 - 小家电生产组装进销存管理系统

面向小家电生产企业的网页版进销存系统，覆盖采购 → 生产 → 销售 → 仓储 → 财务全流程。

当前版本：**V1.4.6（P1 骨架 + P2 采购闭环已落地）**

---

## 一、技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | React 18 + TypeScript + Vite + Ant Design 5 | 进销存大量依赖 Table / Form / Modal，AntD 中文完善、开箱即用 |
| 后端 | Express + TypeScript | 足够轻，靠目录分层保证结构 |
| 数据库 | SQLite（better-sqlite3） | 单机零运维；**同步 API + 原生事务**，库存扣减的原子性天然可靠 |
| 数据访问 | 原生 SQL + 薄 Repository | 报表与库存聚合 SQL 复杂，ORM 反而绕；便于后续换 Postgres |
| 校验 | Zod | 前后端共用同一套入参约束 |
| 状态 | Zustand（仅 auth）+ 组件内 useState | 单据列表本质是服务端状态，不引入额外缓存层 |

## 二、快速开始

```bash
npm install        # 首次安装（根目录，workspaces 自动装前后端）
npm run dev        # 同时启动后端 :3001 与前端 :5173
```

打开 http://localhost:5173 ，演示账号：

| 账号 | 角色 | 初始密码 |
|---|---|---|
| admin | 管理员 | admin12345 |
| purchaser | 采购人员 | admin12345 |
| warehouse | 仓库管理员 | admin12345 |
| finance | 财务人员 | admin12345 |
| producer | 生产人员 | admin12345 |
| sales | 销售人员 | admin12345 |
| viewer | 普通查询人员 | admin12345 |

> 冒烟脚本会修改 purchaser 的密码为 `purchaser888`。

其他命令：

```bash
npm run dev:server    # 只启动后端
npm run dev:web       # 只启动前端
npm run typecheck     # 前后端类型检查
npm run db:reset      # 清空数据文件，下次启动重建演示数据
```

端到端冒烟（需后端已启动，按顺序跑即可）：

```bash
node server/scripts/smoke.mjs                 # P2 采购闭环
node server/scripts/smoke-production.mjs      # P3 生产
node server/scripts/smoke-sales-warehouse.mjs # P4 销售与仓储
node server/scripts/smoke-finance.mjs         # P5 财务与系统设置（末尾会执行系统初始化，清空数据）
node server/scripts/smoke-ocr-dashboard.mjs   # P6 工作台大屏 & OCR 建单
```

> 冒烟脚本会修改 purchaser 的密码为 `purchaser888`；`smoke-finance.mjs` 最后会清空业务数据，
> 跑完需要 `npm run db:reset` 并重启后端才能恢复演示数据。

### 手机端验证方式

1. **Chrome DevTools 设备模拟**（最快）：
   F12 → 点设备工具栏 → 选 iPhone SE (375) / iPhone XR (414)，或直接拖宽度到 375 / 414；
   逐页检查：无横向滚动条、列表呈卡片状、右上角汉堡可展开菜单、右下角有悬浮「新增」按钮。
2. **真机验证**：`npm run dev` 后手机连同一 Wi-Fi，浏览器访问 `http://<电脑IP>:5173`
   （`npm run dev:web -- --host` 可显式开放监听）。重点体验：输入框聚焦是否放大页面、
   键盘弹起后悬浮按钮是否隐藏、弹窗底部按钮是否好按。
3. **自动化溢出扫描**：在设备模拟下于控制台执行
   `document.documentElement.scrollWidth > window.innerWidth + 1`，
   逐页应为 `false`（本仓库 30 个页面在 375 / 414 / 320px 下均已验证为 false）。

## 三、目录结构

```
├── shared/                 # ★ 前后端共享常量：权限矩阵、枚举、摘要格式
│   ├── permissions.ts
│   └── enums.ts
├── server/
│   └── src/
│       ├── db/             # 连接、迁移（00x_*.sql）、演示数据
│       ├── core/           # ★ 领域核心（横切能力，业务模块不得绕过）
│       │   ├── ledger.ts   #   库存引擎：唯一可变更库存的入口
│       │   ├── bom.ts      #   BOM 展开与虚拟件穿透
│       │   ├── code.ts     #   单据编号（全局递增，不重置）
│       │   ├── serializer.ts # 出口脱敏与入库单号裁剪
│       │   ├── template.ts #   打印模板引擎（{{字段}} + {{#items}} 循环）
│       │   └── log.ts      #   操作审计
│       ├── middleware/     # 鉴权（JWT + session_version）、权限点、错误处理
│       └── modules/        # auth / archive / inventory / purchase / production /
│                           # sale / warehouse / finance / reports / system / dashboard
└── web/
    └── src/
        ├── api/            # 统一请求封装（401 自动踢线）
        ├── layouts/ router/ stores/ hooks/ components/
        └── features/       # 按业务模块组织页面
```

## 四、三条不可绕过的架构约束

改动任何业务代码前请先理解这三条，它们是需求里最硬的部分：

1. **库存变更必须走 `core/ledger.ts` 的 `applyStock()`**
   禁止任何模块直接 `UPDATE current_stock`。撤销 = 反向对冲流水（`reverseStock`），不是删记录。
   汇总口径统一为 `status='有效' AND is_reversal=0`，所以撤销单据与对冲行都不计入净额。

2. **入库单号在出口层统一裁剪**
   DB 保留 `receipt_no` 用于追溯与回滚，由 `core/serializer.ts` 在 API 出口剔除。
   不要在页面里逐个 `delete` —— 需求要求列表、导出、打印、弹窗全部无单号，散着改必漏。

3. **权限判断用权限点，不判断角色**
   页面按钮与服务端校验共用 `shared/permissions.ts` 里的 `purchase.receipt.create` 这类权限点，
   角色矩阵只是权限点的分组配置。硬编码角色后续无法调整。

## 五、已实现功能

### P1 骨架
- 登录 / JWT 鉴权 / 角色权限矩阵 / **管理员改密码后强制踢线**（session_version）
- 主框架：按权限动态菜单、路由、布局
- 基础档案：物料（含虚拟件）、成品 + BOM（含**成品复制**）、供应商、客户
- 期初库存录入（设定语义，重复提交自动回滚历史期初）
- 库存查询：表头全局排序（空值排末尾）、低库存标记、**出入库详情弹窗**（净额统计 + 价格脱敏）
- 流水台账（撤销记录划线保留，无入库单号）
- 用户管理与操作日志

### P2 采购闭环
- 采购订单：双模式建单（按 BOM / 直接采购）、主产品拼音检索、**按默认供应商自动拆单**
- 采购摘要统一「A、B等N项」格式，悬浮看全量，导出同步
- **去入库**：仅进行中且有未入库明细的非父单显示，跳转后自动带出订单与待入库明细
- 采购入库：赠品行、超量待结算标记、移动加权成本、**撤销自动回滚库存**
- 到货核对：采购内容列 + 主产品/物料搜索
- 采购退货：关联入库单，扣减库存并冲减应付

### P3 生产
- 生产工单、生产领料（BOM 展开 + 虚拟件穿透 + 外箱）、成品入库（已领料 / 直接扣料 / 售后返修）
- 防超产（服务端强制校验）、多品入库局部缺料独立拦截（409 + `skipProductIds` 跳过继续）
- 「去入库」按是否已领料分流

### P4 销售与仓储
- 销售开单（建单即校验库存）/ 出库 / 退货、物料销售、不良品出库
- 库存盘点（录入即锁定出入库，审核后按差异自动生成调整流水）
- 模拟出货排产（缺料试算 + 一键生成工单）、四级预警看板

### P5 财务与系统设置
- **采购结算中心**：供应商应付汇总、付款单登记、**自动核销（退货优先冲减 + 按日期 FIFO）**、核销试算、撤销回滚
- **报表中心**：元数据驱动，9 张报表（采购 3 / 生产 2 / 销售 2 / 库存 2），新增报表只改后端 `REPORTS`
- **打印模板**：9 类单据，模板存库可改，服务端渲染 + 实时预览，含**人民币金额大写**；入库类单据打印件不含单号
- **Excel 批量导入**：物料 / 供应商 / 客户 / 期初库存，前端解析预览、服务端整批事务落库，失败全回滚并回显行号原因
- **系统参数**：预警阈值（安全库存 / 严重缺货 / 超储 / 呆滞天数）可配置；企业信息用于打印抬头
- **系统初始化**：分组清空（业务单据 / 基础档案）+ 库存清零，需输入「确认清空」，单事务原子；**编号序列永不重置**

### P6 工作台大屏 & OCR 建单
- **工作台大屏**：8 张指标卡（含库存金额、本月采购/销售额）、5 项真实取值的待办、快捷入口、今日流水、**自绘 SVG 七日趋势图**（补齐缺失日期）、告警 Top5；无价格权限的角色拿不到金额类指标
- **OCR 建单**：上传送货单照片 → 识别为草稿 → 人工修正 → 回填入库单；识别结果**永远只是草稿**，库存变更仍只走 ledger
  - 服务端 `core/ocr.ts` 内置确定性 mock（可复现、适配任意库），**真实服务只需替换 `callProvider()`**
  - `ocr_logs` 记录每次请求与采纳情况（`/purchase/ocr/stats` 识别采纳率）
  - 4MB 体积上限 + MIME 白名单；async 路由统一 `asyncRoute()` 包装（Express 4 不捕获 async 异常）

### 移动端适配
- **断点**：`768px`（手机/平板分界）、`414px`（主流大屏手机）、`375px`（小屏手机），全部只在 `max-width` 下生效，桌面端零改动
- 表格窄屏自动降级为**卡片列表**（`ResponsiveTable`），彻底消灭横向滚动
- 侧栏变抽屉 + 左上角汉堡按钮；「新增」类主操作变**右下角悬浮按钮**（拇指热区），键盘弹起时自动隐藏
- 触控区 ≥44×44px（按钮 / 菜单 / 分页 / 输入框 / 复选框），输入框字号 16px 防 iOS 聚焦自动放大
- Modal 全宽 + **底部吸附操作条**、按钮间距加大防误触、危险按钮与取消拉开距离
- 图片 `max-width:100%` 自适应，`env(safe-area-inset-*)` 适配刘海屏底部安全区

## 六、部署与多人共享

前端可静态托管（GitHub Pages，已含 `.github/workflows/deploy-pages.yml` 自动发布），
多人共享数据的关键是**所有人连同一个后端实例**。完整方案（外部服务选型、环境变量、
安全注意事项、按步骤执行的部署清单）见 **[docs/部署与多人共享方案.md](docs/部署与多人共享方案.md)**。

### 更新到云服务器（106.55.93.200）

**先记住一件事**：云服务器跑的是它自己 `/opt/zhigong` 里的代码和 `web/dist` 编译产物，
**跟本机 `web/src` 里的源码没有任何联动**。在本机改了源码、换了图片，云服务器上不会自动变，
必须执行下面任一种方式把改动推过去。

| 方式 | 命令 | 说明 |
|---|---|---|
| 本机一键同步（推荐） | `CLOUD_PASS='服务器密码' node deploy/sync-cloud.mjs` | 构建 → 备份 → 上传 → 逐个替换 → 清理旧资源 → 重启 → 体检，失败自动回滚 |
| 只比对不改动 | `CLOUD_PASS='xxx' node deploy/sync-cloud.mjs --check` | 逐文件 MD5 比对，看本机和云端差在哪 |
| 在服务器上更新 | `cd /opt/zhigong && bash deploy/update-cloud.sh` | 走 git pull + 构建 + 重启的方式 |

只改了**公司名称**的话，不需要动代码：进系统「系统参数 → 企业信息 → 公司名称」改即可，
它存在数据库 `app_settings.company.name` 里，改完立即生效，也是打印抬头的取值来源。

## 七、待实现（后续增量迭代）

| 期 | 内容 |
|---|---|
| P7 | 接入真实 OCR 服务（替换 `core/ocr.ts` 的 `callProvider()`）、销售收款结算（复用结算核销模型）、消息/预警推送 |

## 八、扩展点提示

- **OCR 建单**：采购入库已预留 `source` 字段与 `purchase_receipts.source='ocr'` 分支，接识别服务时只需在建单入口把解析结果转成 items。
- **换数据库**：只需替换 `server/src/db/index.ts` 的连接实现，SQL 集中在各 module 内，迁移时可平滑切到 Postgres。
- **Excel 导出**：目前用 CSV（带 BOM）承载，调用方只依赖 `utils/exportCsv.ts` 的 `exportCsv()`，换 xlsx 库不影响业务代码。
