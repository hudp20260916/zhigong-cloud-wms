import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Popconfirm,
  Row,
  Select,
  Space,
  Tag,
  Tooltip,
  message,
} from 'antd';
import { printApi, purchaseApi, productionApi, saleApi } from '../../api';
import { PermPage } from '../../components';
import PrintPreview from '../../components/PrintPreview';

/**
 * 打印模板管理。
 *
 * 渲染只发生在服务端（前端拿到的永远是渲染后的 HTML），
 * 这样「入库单号不出现在打印件」这条硬需求只有一个出口可控。
 *
 * 布局取舍：编辑类操作全部收进左侧纵向可折叠分组，右侧留给预览。
 * 原因很直接 —— 打印模板不看预览等于盲改，A4 竖版 100% 显示需要 794px 宽，
 * 原来三栏横向排布时预览只分到 1/3 宽度，永远看不到整页。
 */
export default function PrintTemplatePage() {
  return (
    <PermPage permission="system.print.manage">
      <PrintInner />
    </PermPage>
  );
}

/** 各单据类型的示例数据来源，用于预览 */
const SAMPLE_SOURCE: Record<string, (p?: any) => Promise<any>> = {
  purchase_order: (p) => purchaseApi.orders({ pageSize: 5, ...p }),
  purchase_receipt: (p) => purchaseApi.receipts({ pageSize: 5, ...p }),
  purchase_return: (p) => purchaseApi.returns({ pageSize: 5, ...p }),
  work_order: (p) => productionApi.workOrders({ pageSize: 5, ...p }),
  material_issue: (p) => productionApi.issues({ pageSize: 5, ...p }),
  product_receipt: (p) => productionApi.receipts({ pageSize: 5, ...p }),
  sale_order: (p) => saleApi.orders({ pageSize: 5, ...p }),
  sale_delivery: (p) => saleApi.deliveries({ pageSize: 5, ...p }),
  sale_return: (p) => saleApi.returns({ pageSize: 5, ...p }),
};

const PAPERS = [
  { value: 'A4', label: 'A4（210×297mm）' },
  { value: 'A5', label: 'A5（148×210mm）' },
  { value: 'P241', label: '针式 241×140mm' },
];

const DOC_LABEL_WIDTH = 96;

function PrintInner() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [docType, setDocType] = useState('purchase_order');
  const [content, setContent] = useState('');
  const [paper, setPaper] = useState('A4');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [fields, setFields] = useState<any>(null);
  const [samples, setSamples] = useState<any[]>([]);
  const [sampleId, setSampleId] = useState<number | undefined>();
  const [html, setHtml] = useState('');
  const [saved, setSaved] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  /** 左侧编辑面板是否收起：收起后预览独占整行，专供「只看版式」的场景 */
  const [panelOpen, setPanelOpen] = useState(true);
  const timer = useRef<any>(null);

  const reloadTemplates = () => printApi.templates().then(setTemplates).catch(() => setTemplates([]));

  useEffect(() => {
    reloadTemplates();
  }, []);

  // 切换单据类型：加载模板 + 可用字段 + 示例单据
  useEffect(() => {
    let alive = true;
    Promise.all([printApi.template(docType), printApi.fields(docType)])
      .then(([tpl, f]) => {
        if (!alive) return;
        setContent(tpl.content);
        setPaper(tpl.paper);
        setOrientation(tpl.orientation);
        setSaved(tpl);
        setFields(f);
        setDirty(false);
      })
      .catch((e: any) => message.error(e.message));

    const src = SAMPLE_SOURCE[docType];
    if (src) {
      src()
        .then((r: any) => {
          if (!alive) return;
          const list = r.list ?? [];
          setSamples(list);
          setSampleId(list[0]?.id);
        })
        .catch(() => {
          if (alive) {
            setSamples([]);
            setSampleId(undefined);
          }
        });
    }
    return () => {
      alive = false;
    };
  }, [docType]);

  // 实时预览：内容/纸张/示例单据变化后 500ms 防抖请求服务端渲染
  useEffect(() => {
    if (!content || !sampleId) {
      setHtml('');
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      printApi
        .preview({ docType, content, id: sampleId, paper, orientation })
        .then((r) => setHtml(r.html))
        .catch((e: any) => setHtml(`<pre style="color:#c00;padding:12px">${e.message}</pre>`));
    }, 500);
    return () => clearTimeout(timer.current);
  }, [docType, content, sampleId, paper, orientation]);

  const current = useMemo(() => templates.find((t) => t.docType === docType), [templates, docType]);

  async function save() {
    try {
      const r = await printApi.saveTemplate(docType, { paper, orientation, content });
      message.success('模板已保存，后续打印立即生效');
      setSaved(r);
      setDirty(false);
      reloadTemplates();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function reset() {
    try {
      const r = await printApi.resetTemplate(docType);
      setContent(r.content);
      setPaper(r.paper);
      setOrientation(r.orientation);
      setSaved(r);
      setDirty(false);
      message.success('已恢复默认模板');
      reloadTemplates();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  function print() {
    if (!sampleId) return message.warning('请先选择一张示例单据');
    const w = window.open(printApi.renderUrl(docType, sampleId), '_blank');
    if (!w) message.warning('浏览器拦截了弹出窗口，请允许后重试');
  }

  const docList = (
    <div style={{ maxHeight: 260, overflow: 'auto' }}>
      {templates.map((t) => (
        <div
          key={t.docType}
          onClick={() => setDocType(t.docType)}
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            borderBottom: '1px solid #f0f0f0',
            background: t.docType === docType ? '#e6f4ff' : undefined,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{t.name}</span>
          {t.isCustom ? <Tag color="blue">已定制</Tag> : <Tag>默认</Tag>}
        </div>
      ))}
    </div>
  );

  const settingForm = (
    <div style={{ display: 'grid', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: DOC_LABEL_WIDTH, color: '#666', fontSize: 12 }}>纸张</span>
        <Select size="small" style={{ flex: 1 }} value={paper} onChange={setPaper} options={PAPERS} />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: DOC_LABEL_WIDTH, color: '#666', fontSize: 12 }}>方向</span>
        <Select
          size="small"
          style={{ flex: 1 }}
          value={orientation}
          onChange={setOrientation}
          options={[
            { value: 'portrait', label: '纵向' },
            { value: 'landscape', label: '横向' },
          ]}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: DOC_LABEL_WIDTH, color: '#666', fontSize: 12 }}>示例单据</span>
        <Select
          size="small"
          showSearch
          style={{ flex: 1 }}
          placeholder="预览用示例单据"
          value={sampleId}
          onChange={setSampleId}
          options={samples.map((s: any) => ({
            value: s.id,
            label:
              s.order_no ?? s.wo_no ?? s.issue_no ?? s.delivery_no ?? s.return_no ??
              (s.receipt_date ? `入库 ${s.receipt_date}` : null) ?? `#${s.id}`,
          }))}
        />
      </label>
    </div>
  );

  const sourceEditor = (
    <>
      <textarea
        className="tpl-src"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        style={{
          width: '100%',
          height: 380,
          fontFamily: 'Consolas, Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.6,
          padding: 8,
          border: '1px solid #d9d9d9',
          borderRadius: 6,
          resize: 'vertical',
        }}
      />
      {saved?.updatedAt && (
        <div style={{ marginTop: 6, color: '#888', fontSize: 12 }}>
          最近修改：{saved.updatedByName ?? '—'} ·{' '}
          {String(saved.updatedAt).slice(0, 19).replace('T', ' ')}
        </div>
      )}
    </>
  );

  const fieldPanel = fields ? (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message={
          <span>
            用 <code>{'{{字段}}'}</code> 引用变量，用 <code>{'{{#items}}...{{/items}}'}</code>{' '}
            循环明细行；点击标签可插入到光标处
          </span>
        }
      />
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="表头字段">
          <Space size={[4, 4]} wrap>
            {fields.head.map((f: any) => (
              <Tag key={f.key} color="blue" style={{ cursor: 'pointer' }} onClick={() => insert(f.key)}>
                {`{{${f.key}}}`}
              </Tag>
            ))}
            {fields.common.map((f: any) => (
              <Tag key={f.key} style={{ cursor: 'pointer' }} onClick={() => insert(f.key)}>
                {`{{${f.key}}}`}
              </Tag>
            ))}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="明细字段">
          <Space size={[4, 4]} wrap>
            {fields.item.map((f: any) => (
              <Tag key={f.key} color="green" style={{ cursor: 'pointer' }} onClick={() => insert(f.key)}>
                {`{{${f.key}}}`}
              </Tag>
            ))}
            <Tag style={{ cursor: 'pointer' }} onClick={() => insert('__index')}>
              {'{{__index}}'}
            </Tag>
          </Space>
        </Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
        字段名含义：{fields.head.map((f: any) => `${f.key}=${f.label}`).join('、')}
      </div>
    </>
  ) : (
    <span style={{ color: '#999' }}>加载中…</span>
  );

  /** 字段标签点击插入到 textarea 光标处 —— 手敲占位符最容易敲错 */
  function insert(key: string) {
    const el = document.querySelector<HTMLTextAreaElement>('.tpl-src');
    const token = `{{${key}}}`;
    if (!el) {
      setContent((c) => c + token);
      setDirty(true);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setContent((c) => c.slice(0, start) + token + c.slice(end));
    setDirty(true);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div>
      {/* 顶部操作条：保存/恢复默认常驻，不随折叠面板隐藏 */}
      <Card size="small" styles={{ body: { padding: 8 } }} style={{ marginBottom: 12 }}>
        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space wrap size={6}>
            <strong>打印模板</strong>
            <Tag color={current?.isCustom ? 'blue' : undefined}>{current?.name ?? '—'}</Tag>
            {dirty && <Tag color="orange">未保存</Tag>}
          </Space>
          <Space wrap size={6}>
            <Tooltip title={panelOpen ? '收起编辑面板，预览独占整行' : '展开编辑面板'}>
              <Button size="small" onClick={() => setPanelOpen((v) => !v)}>
                {panelOpen ? '收起编辑' : '展开编辑'}
              </Button>
            </Tooltip>
            <Button size="small" onClick={print}>
              打印
            </Button>
            <Popconfirm title="恢复为系统默认模板？" description="当前自定义内容将丢失" onConfirm={reset}>
              <Button size="small">恢复默认</Button>
            </Popconfirm>
            <Button size="small" type="primary" onClick={save} disabled={!dirty}>
              保存
            </Button>
          </Space>
        </Space>
      </Card>

      <Row gutter={12}>
        {panelOpen && (
          <Col xs={24} lg={7}>
            <Collapse
              size="small"
              defaultActiveKey={['doc', 'src']}
              items={[
                { key: 'doc', label: '单据类型', children: docList },
                { key: 'opt', label: '纸张与预览数据', children: settingForm },
                { key: 'src', label: '模板源码', children: sourceEditor },
                { key: 'field', label: '可用字段', children: fieldPanel },
              ]}
            />
          </Col>
        )}

        <Col xs={24} lg={panelOpen ? 17 : 24}>
          <PrintPreview html={html} paper={paper} orientation={orientation} />
        </Col>
      </Row>
    </div>
  );
}
