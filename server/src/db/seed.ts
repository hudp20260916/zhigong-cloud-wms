import bcrypt from 'bcryptjs';
import { db, nowIso, tx } from './index.js';
import { applyStock } from '../core/ledger.js';
import { pinyinInitials } from '../core/pinyin.js';
import type { Role } from '../../../shared/permissions.js';

const DEFAULT_PASSWORD = 'admin12345';

interface SeedMaterial {
  code: string;
  name: string;
  spec: string;
  unit: string;
  supplier: string;
  safety: number;
  stock: number;
  price: number;
  virtual?: boolean;
  children?: { code: string; qty: number }[];
}

const SUPPLIERS = [
  { code: 'S101', name: '深圳市恒信电子有限公司', contact: '陈经理', phone: '13800000001' },
  { code: 'S102', name: '东莞市精工塑胶制品厂', contact: '刘主管', phone: '13800000002' },
  { code: 'S103', name: '中山市华泰五金配件厂', contact: '黄厂长', phone: '13800000003' },
];

const MATERIALS: SeedMaterial[] = [
  { code: 'M1001', name: '电源线', spec: '1.8m 三插', unit: '条', supplier: 'S101', safety: 500, stock: 1200, price: 3.2 },
  { code: 'M1002', name: '直流电机', spec: '220V 30W', unit: '台', supplier: 'S101', safety: 120, stock: 260, price: 18.5 },
  { code: 'M1003', name: '塑料外壳', spec: 'ABS 白色', unit: '个', supplier: 'S102', safety: 300, stock: 640, price: 7.8 },
  { code: 'M1004', name: '螺丝包', spec: 'M3*10 十件套', unit: '包', supplier: 'S103', safety: 200, stock: 900, price: 1.1 },
  { code: 'M1005', name: '控制面板', spec: '触摸式', unit: '个', supplier: 'S101', safety: 100, stock: 180, price: 12.4 },
  { code: 'M1006', name: '外箱', spec: '5层瓦楞纸箱', unit: '个', supplier: 'S103', safety: 200, stock: 500, price: 4.6 },
  { code: 'M1007', name: '说明书', spec: '中英双语', unit: '本', supplier: 'S103', safety: 300, stock: 800, price: 0.8 },
  { code: 'M1008', name: '发热盘', spec: '不锈钢 800W', unit: '个', supplier: 'S101', safety: 120, stock: 210, price: 15.3 },
  { code: 'M1009', name: '温控器', spec: 'KSD 105℃', unit: '个', supplier: 'S101', safety: 120, stock: 240, price: 6.2 },
  // 虚拟件：领料时穿透为发热盘 + 温控器，本身不占库存
  {
    code: 'M1010',
    name: '发热组件',
    spec: '虚拟件',
    unit: '套',
    supplier: 'S101',
    safety: 0,
    stock: 0,
    price: 0,
    virtual: true,
    children: [
      { code: 'M1008', qty: 1 },
      { code: 'M1009', qty: 1 },
    ],
  },
];

const PRODUCTS = [
  {
    code: 'P1001',
    name: '多功能电热水壶',
    spec: '1.7L',
    unit: '台',
    packing: '6台/箱',
    carton: 'M1006',
    safety: 50,
    stock: 120,
    bom: [
      { code: 'M1001', qty: 1 },
      { code: 'M1003', qty: 1 },
      { code: 'M1010', qty: 1 },
      { code: 'M1005', qty: 1 },
      { code: 'M1004', qty: 1 },
      { code: 'M1007', qty: 1 },
    ],
  },
  {
    code: 'P1002',
    name: '小型电吹风',
    spec: '1600W',
    unit: '台',
    packing: '10台/箱',
    carton: 'M1006',
    safety: 40,
    stock: 80,
    bom: [
      { code: 'M1001', qty: 1 },
      { code: 'M1002', qty: 1 },
      { code: 'M1003', qty: 1 },
      { code: 'M1005', qty: 1 },
      { code: 'M1004', qty: 1 },
      { code: 'M1007', qty: 1 },
    ],
  },
];

const USERS: { username: string; name: string; role: Role }[] = [
  { username: 'admin', name: '系统管理员', role: 'admin' },
  { username: 'purchaser', name: '采购员小李', role: 'purchaser' },
  { username: 'warehouse', name: '库管老王', role: 'warehouse' },
  { username: 'finance', name: '财务小张', role: 'finance' },
  { username: 'producer', name: '生产员小赵', role: 'producer' },
  { username: 'sales', name: '销售员小孙', role: 'sales' },
  { username: 'viewer', name: '查询员小陈', role: 'viewer' },
];

const CUSTOMERS = [
  { code: 'C101', name: '广州家宜商贸有限公司', contact: '林经理', phone: '13900000001' },
  { code: 'C102', name: '佛山市顺德家电连锁', contact: '何店长', phone: '13900000002' },
];

/** 首次启动写入演示数据；已有数据时不覆盖，保证用户录入的数据不丢 */
export function seedIfEmpty(): void {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
  if (count.c > 0) return;

  tx(() => {
    const now = nowIso();
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);

    const insUser = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, status, session_version, created_at, updated_at)
       VALUES (?,?,?,?, 'active', 1, ?,?)`,
    );
    for (const u of USERS) insUser.run(u.username, hash, u.name, u.role, now, now);

    const insSupplier = db.prepare(
      `INSERT INTO suppliers (code, name, contact, phone, created_at) VALUES (?,?,?,?,?)`,
    );
    const supplierIds = new Map<string, number>();
    for (const s of SUPPLIERS) {
      const info = insSupplier.run(s.code, s.name, s.contact, s.phone, now);
      supplierIds.set(s.code, Number(info.lastInsertRowid));
    }

    const insCustomer = db.prepare(
      `INSERT INTO customers (code, name, contact, phone, created_at) VALUES (?,?,?,?,?)`,
    );
    for (const c of CUSTOMERS) insCustomer.run(c.code, c.name, c.contact, c.phone, now);

    const insMaterial = db.prepare(
      `INSERT INTO materials (code, name, pinyin, spec, category, unit, default_supplier_id,
         safety_stock, current_stock, avg_cost, is_virtual, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?)`,
    );
    const materialIds = new Map<string, number>();
    for (const m of MATERIALS) {
      const info = insMaterial.run(
        m.code,
        m.name,
        pinyinInitials(m.name),
        m.spec,
        '通用件',
        m.unit,
        supplierIds.get(m.supplier) ?? null,
        m.safety,
        m.virtual ? 1 : 0,
        now,
        now,
      );
      materialIds.set(m.code, Number(info.lastInsertRowid));
    }

    for (const m of MATERIALS) {
      if (!m.children) continue;
      const parentId = materialIds.get(m.code)!;
      const insV = db.prepare(
        `INSERT INTO virtual_bom_items (parent_material_id, child_material_id, qty_per_unit) VALUES (?,?,?)`,
      );
      for (const c of m.children) insV.run(parentId, materialIds.get(c.code)!, c.qty);
    }

    const insProduct = db.prepare(
      `INSERT INTO products (code, name, pinyin, spec, unit, packing_spec, carton_material_id,
         safety_stock, current_stock, bom_version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,0,'V1.0',?,?)`,
    );
    const insBom = db.prepare(
      `INSERT INTO bom_items (product_id, material_id, qty_per_unit) VALUES (?,?,?)`,
    );
    const productIds = new Map<string, number>();
    for (const p of PRODUCTS) {
      const info = insProduct.run(
        p.code,
        p.name,
        pinyinInitials(p.name),
        p.spec,
        p.unit,
        p.packing,
        materialIds.get(p.carton) ?? null,
        p.safety,
        now,
        now,
      );
      const pid = Number(info.lastInsertRowid);
      productIds.set(p.code, pid);
      for (const b of p.bom) insBom.run(pid, materialIds.get(b.code)!, b.qty);
    }

    // 期初库存：统一走 applyStock 写流水，保证台账与现存量一致
    for (const m of MATERIALS) {
      if (m.stock <= 0) continue;
      applyStock([
        {
          itemType: 'material',
          itemId: materialIds.get(m.code)!,
          direction: 'in',
          qty: m.stock,
          bizType: '期初库存',
          unitPrice: m.price,
          operatorId: 1,
          allowNegative: true,
        },
      ]);
      db.prepare(`UPDATE materials SET avg_cost = ? WHERE id = ?`).run(
        m.price,
        materialIds.get(m.code)!,
      );
    }
    for (const p of PRODUCTS) {
      if (p.stock <= 0) continue;
      applyStock([
        {
          itemType: 'product',
          itemId: productIds.get(p.code)!,
          direction: 'in',
          qty: p.stock,
          bizType: '期初库存',
          operatorId: 1,
          allowNegative: true,
        },
      ]);
    }
  });

  console.log('[db] 已写入演示数据，默认账号 admin / admin12345');
}
