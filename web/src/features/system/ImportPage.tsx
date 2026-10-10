import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Progress,
  Row,
  Space,
  Steps,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { importApi } from '../../api';
import { PermPage, ResponsiveTable } from '../../components';

/**
 * Excel 批量导入。
 *
 * 解析放在前端（用户选完文件就能看到表格并逐行改），
 * 唯一性 / 外键 / 数量合法性放在服务端（必须查库），落库整批一个事务。
 */
export default function ImportPage() {
  return (
    <PermPage permission="system.import.execute">
      <ImportInner />
    </PermPage>
  );
}

function ImportInner() {
  const [kinds, setKinds] = useState<any[]>([]);
  const [kind, setKind] = useState('material');
  const [rows, setRows] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [fileName, setFileName] = useState('');
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    importApi
      .kinds()
      .then((k) => {
        setKinds(k);
        if (k.length > 0) setKind(k[0].kind);
      })
      .catch((e: any) => message.error(e.message));
  }, []);

  const def = useMemo(() => kinds.find((k) => k.kind === kind), [kinds, kind]);
  const columns = useMemo(() => def?.columns ?? [], [def]);

  /** 表头中文 -> 字段 key */
  const headerMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of columns) m.set(c.label, c.key);
    // 也支持直接用英文 key 作表头
    for (const c of columns) m.set(c.key, c.key);
    return m;
  }, [columns]);

  function reset() {
    setRows([]);
    setErrors([]);
    setFileName('');
    setStep(0);
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
      if (raw.length < 2) {
        message.warning('文件内容为空或只有表头');
        return;
      }
      const [header, ...body] = raw;
      const mapped = body.map((line) => {
        const obj: any = {};
        (header ?? []).forEach((h: any, i: number) => {
          const key = headerMap.get(String(h ?? '').trim());
          if (key) obj[key] = line[i];
        });
        return obj;
      });
      setRows(mapped);
      setErrors([]);
      setStep(1);

      // 立即做一次不查库的基础校验，让用户先看到格式问题
      const r = await importApi.preview({ kind, rows: mapped });
      setErrors(r.errors ?? []);
    } catch (e: any) {
      message.error(`文件解析失败：${e.message}`);
    }
  }

  async function execute() {
    if (rows.length === 0) return message.warning('请先选择文件');
    setSubmitting(true);
    try {
      const r = await importApi.execute({ kind, fileName, rows });
      setResult(r);
      setErrors(r.errors ?? []);
      setStep(2);
      if (r.failed === 0) message.success(`导入成功 ${r.success} 行`);
      else message.warning(`导入失败 ${r.failed} 行，已整批回滚，请修正后重试`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  function downloadTemplate() {
    if (!def) return;
    const ws = XLSX.utils.aoa_to_sheet([columns.map((c: any) => c.label)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '模板');
    XLSX.writeFile(wb, `${def.name}_导入模板.xlsx`);
  }

  const errByRow = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of errors) m.set(e.row, e.message);
    return m;
  }, [errors]);

  return (
    <Card title="Excel 批量导入">
      <Steps
        size="small"
        current={step}
        style={{ marginBottom: 16 }}
        items={[{ title: '选择文件' }, { title: '预览校验' }, { title: '导入完成' }]}
      />

      <Space wrap style={{ marginBottom: 12 }}>
        <span>导入类型：</span>
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            reset();
          }}
          style={{ height: 32, minWidth: 160, borderRadius: 6, border: '1px solid #d9d9d9' }}
        >
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.name}
            </option>
          ))}
        </select>
        <Button onClick={downloadTemplate}>下载模板</Button>
        <Button
          type="primary"
          disabled={rows.length === 0 || errors.length > 0}
          loading={submitting}
          onClick={execute}
        >
          确认导入 {rows.length > 0 ? `（${rows.length} 行）` : ''}
        </Button>
        <Button onClick={reset}>重新选择</Button>
      </Space>

      {def && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={def.hint} />}

      {step === 0 && (
        <Upload.Dragger
          accept=".xlsx,.xls,.csv"
          showUploadList={false}
          beforeUpload={(file) => {
            handleFile(file as unknown as File);
            return false;
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽文件到此处</p>
          <p className="ant-upload-hint">支持 .xlsx / .xls / .csv，首行需为表头</p>
        </Upload.Dragger>
      )}

      {step >= 1 && (
        <>
          <div style={{ marginBottom: 8 }}>
            <Tag color="blue">{fileName || '未命名文件'}</Tag>
            {errors.length > 0 ? (
              <Tag color="red">{errors.length} 行有问题</Tag>
            ) : (
              <Tag color="green">格式校验通过</Tag>
            )}
          </div>
          <ResponsiveTable
            size="small"
            rowKey={(_r, i) => String(i)}
            dataSource={rows}
            scroll={{ x: 900, y: 380 }}
            pagination={{ pageSize: 50 }}
            rowClassName={(_r, i) => (errByRow.has((i ?? 0) + 2) ? 'row-error' : '')}
            columns={[
              {
                title: '行号',
                width: 70,
                render: (_v, _r, i) => (i ?? 0) + 2,
              },
              ...columns.map((c: any) => ({
                title: c.label + (c.required ? ' *' : ''),
                dataIndex: c.key,
                key: c.key,
                width: 140,
                render: (v: any) => (v === undefined || v === null || v === '' ? <span style={{ color: '#bbb' }}>—</span> : String(v)),
              })),
              {
                title: '校验结果',
                width: 220,
                render: (_v, _r, i) => {
                  const msg = errByRow.get((i ?? 0) + 2);
                  return msg ? <span style={{ color: '#cf1322' }}>{msg}</span> : <Tag color="green">通过</Tag>;
                },
              },
            ]}
          />
        </>
      )}

      {step === 2 && result && (
        <Row gutter={12} style={{ marginTop: 16 }}>
          <Col xs={24} sm={12}>
            <Card size="small" title="导入结果">
              <Progress
                percent={Math.round((result.success / Math.max(1, result.total)) * 100)}
                status={result.failed > 0 ? 'exception' : 'success'}
              />
              <div style={{ marginTop: 8 }}>
                共 {result.total} 行，成功 {result.success} 行，失败 {result.failed} 行
              </div>
              {result.failed > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 8 }}
                  message="存在失败行时整批回滚，不会留下半截数据"
                />
              )}
            </Card>
          </Col>
          <Col xs={24} sm={12}>
            <Card size="small" title="失败明细">
              {result.errors.length === 0 ? (
                <span style={{ color: '#888' }}>无</span>
              ) : (
                <ResponsiveTable
                  size="small"
                  rowKey="row"
                  dataSource={result.errors}
                  pagination={{ pageSize: 8 }}
                  columns={[
                    { title: '行号', dataIndex: 'row', width: 70 },
                    { title: '原因', dataIndex: 'message' },
                  ]}
                />
              )}
            </Card>
          </Col>
        </Row>
      )}
    </Card>
  );
}
