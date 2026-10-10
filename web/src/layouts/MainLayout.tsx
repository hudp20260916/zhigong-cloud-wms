import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Button, Drawer, Layout, Menu, Space, Tag, Typography } from 'antd';
import {
  AccountBookOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  InboxOutlined,
  LogoutOutlined,
  MenuOutlined,
  SettingOutlined,
  ShoppingOutlined,
  ShoppingCartOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { ROLE_LABEL, type Role } from '@shared/permissions';
import { useAuthStore } from '../stores/auth';
import { useIsMobile } from '../hooks/useIsMobile';

const { Sider, Header, Content } = Layout;

interface MenuNode {
  key: string;
  label: string;
  icon?: React.ReactNode;
  permission?: string;
  children?: MenuNode[];
}

/** 菜单按权限点过滤：无权限的入口直接不渲染 */
const MENU: MenuNode[] = [
  { key: '/dashboard', label: '工作台', icon: <AppstoreOutlined />, permission: 'dashboard.view' },
  {
    key: 'archive',
    label: '基础档案',
    icon: <DatabaseOutlined />,
    children: [
      { key: '/archive/materials', label: '物料档案', permission: 'archive.material.view' },
      { key: '/archive/products', label: '成品档案与 BOM', permission: 'archive.product.view' },
      { key: '/archive/suppliers', label: '供应商档案', permission: 'archive.partner.view' },
      { key: '/archive/customers', label: '客户档案', permission: 'archive.partner.view' },
    ],
  },
  {
    key: 'purchase',
    label: '采购管理',
    icon: <ShoppingOutlined />,
    children: [
      { key: '/purchase/orders', label: '采购订单', permission: 'purchase.order.view' },
      { key: '/purchase/receipts', label: '采购入库', permission: 'purchase.receipt.view' },
      { key: '/purchase/arrivals', label: '到货核对', permission: 'purchase.arrival.view' },
      { key: '/purchase/returns', label: '采购退货', permission: 'purchase.return.view' },
    ],
  },
  {
    key: 'production',
    label: '生产管理',
    icon: <ToolOutlined />,
    children: [
      { key: '/production/work-orders', label: '生产工单', permission: 'production.wo.view' },
      { key: '/production/issues', label: '生产领料', permission: 'production.issue.view' },
      { key: '/production/receipts', label: '成品入库', permission: 'production.receipt.view' },
    ],
  },
  {
    key: 'sale',
    label: '销售管理',
    icon: <ShoppingCartOutlined />,
    children: [
      { key: '/sale/orders', label: '销售开单', permission: 'sale.order.view' },
      { key: '/sale/deliveries', label: '销售出库', permission: 'sale.delivery.view' },
      { key: '/sale/returns', label: '销售退货', permission: 'sale.return.view' },
    ],
  },
  {
    key: 'inventory',
    label: '仓储与库存',
    icon: <InboxOutlined />,
    children: [
      { key: '/inventory/stock', label: '库存查询', permission: 'stock.view' },
      { key: '/inventory/initial', label: '期初库存', permission: 'stock.initial.manage' },
      { key: '/inventory/ledger', label: '流水台账', permission: 'stock.view' },
      { key: '/warehouse/alarm', label: '库存预警看板', permission: 'warehouse.alarm.view' },
      { key: '/warehouse/simulate', label: '模拟出货排产', permission: 'warehouse.simulate.view' },
      { key: '/warehouse/checks', label: '库存盘点', permission: 'warehouse.check.view' },
      { key: '/warehouse/material-sales', label: '物料销售', permission: 'warehouse.materialSale.view' },
      { key: '/warehouse/defectives', label: '不良品出库', permission: 'warehouse.defective.view' },
    ],
  },
  {
    key: 'finance',
    label: '财务与报表',
    icon: <AccountBookOutlined />,
    children: [
      { key: '/finance/settlements', label: '采购结算中心', permission: 'finance.settle.view' },
      { key: '/reports', label: '报表中心', permission: 'report.view' },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    icon: <SettingOutlined />,
    children: [
      { key: '/system/users', label: '用户管理', permission: 'system.user.manage' },
      { key: '/system/logs', label: '操作日志', permission: 'system.view' },
      { key: '/system/print', label: '打印模板', permission: 'system.print.manage' },
      { key: '/system/import', label: 'Excel 批量导入', permission: 'system.import.execute' },
      { key: '/system/settings', label: '系统参数', permission: 'system.view' },
      { key: '/system/init', label: '系统初始化', permission: 'system.init.execute' },
    ],
  },
];

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const has = useAuthStore((s) => s.has);

  const items = useMemo(() => {
    const build = (nodes: MenuNode[]): any[] =>
      nodes
        .filter((n) => {
          if (n.children) return build(n.children).length > 0;
          return !n.permission || has(n.permission);
        })
        .map((n) =>
          n.children
            ? { key: n.key, label: n.label, icon: n.icon, children: build(n.children) }
            : { key: n.key, label: n.label, icon: n.icon },
        );
    return build(MENU);
  }, [has]);

  const selected = location.pathname;
  const openKeys = MENU.filter((m) => m.children?.some((c) => c.key === selected)).map((m) => m.key);

  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const menu = (
    <Menu
      mode="inline"
      items={items}
      selectedKeys={[selected]}
      defaultOpenKeys={openKeys}
      onClick={({ key }) => {
        navigate(key);
        if (isMobile) setDrawerOpen(false);
      }}
      style={{ borderRight: 0 }}
    />
  );

  const userPanel = (
    <Space>
      <Avatar size="small" style={{ backgroundColor: '#1677ff' }}>
        {user?.displayName?.[0] ?? 'U'}
      </Avatar>
      <span>{user?.displayName}</span>
      <Tag color="blue">{ROLE_LABEL[(user?.role ?? 'viewer') as Role] ?? user?.role}</Tag>
      <Button
        size="small"
        icon={<LogoutOutlined />}
        onClick={() => {
          logout();
          navigate('/login');
        }}
      >
        退出
      </Button>
    </Space>
  );

  return (
    <Layout style={{ height: '100%' }}>
      {/* 桌面端保持原样：固定左侧栏；≤768px 收进抽屉，避免侧栏挤压内容宽度 */}
      {!isMobile && (
        <Sider width={200} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
          <div className="app-logo">
            <FileTextOutlined />
            智工云仓
          </div>
          {menu}
        </Sider>
      )}

      {isMobile && (
        <Drawer
          placement="left"
          width={Math.min(280, Math.round(window.innerWidth * 0.82))}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          styles={{ body: { padding: 0 } }}
          title={
            <span>
              <FileTextOutlined /> 智工云仓
            </span>
          }
        >
          {menu}
        </Drawer>
      )}

      <Layout>
        <Header className="app-header">
          {isMobile ? (
            <>
              {/* 汉堡按钮放左上：单手握持时拇指最容易够到 */}
              <Button
                className="menu-trigger"
                type="text"
                icon={<MenuOutlined />}
                onClick={() => setDrawerOpen(true)}
                aria-label="打开菜单"
              />
              <Space size={8}>{userPanel}</Space>
            </>
          ) : (
            <>
              <Typography.Text type="secondary">
                小家电生产组装进销存管理系统 · V1.4.6
              </Typography.Text>
              <Space>{userPanel}</Space>
            </>
          )}
        </Header>
        <Content style={{ padding: 16, overflow: 'auto', background: '#f5f6f8' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
