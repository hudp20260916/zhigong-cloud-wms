import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Row, Select, Space, Steps, Upload, message } from 'antd';
import { CloudUploadOutlined, InboxOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { importApi } from '../../api';
import { PermPage } from '../../components';
import { ImportHeroHeader } from './parts/ImportHeroHeader';
import { ImportPreviewTable } from './parts/ImportPreviewTable';
import { ImportResultPanel } from './parts/ImportResultPanel';
import { buildHeaderMap, mapRows, mapSpecialRows, templateHeader } from './parts/utils';

/**
 * Excel 批量导入（美化版）。
 *
 * 职责边界和改造前完全一致：
 *  - 解析放在前端（用户选完文件就能看到表格并逐行核对）
 *  - 唯一性 / 外键 / 数量合法性放在服务端（必须查库），落库整批一个事务
 * 本次只改展示层：渐变头图 + 四步引导 + 静态子组件拆分。
 * 数据处理逻辑全部下沉到 ./parts/utils.ts，页面里不写映射算法。
 */
export default function ImportPage() {
  return (
    <PermPage permission="system.import.execute">
      <ImportInner />
    </PermPage>
  );
}

const STEP_ITEMS = [{ title: '选择类型' }, { title: '上传文件' }, { title: '预览校验' }, { title: '完成' }];

function ImportInner() {
  const [kinds, setKinds] = useState<any[]>([]);
  const [kind, setKind] = useState('material');
  const [rows, setRows] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [fileName, setFileName] = useState('');
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

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
  const headerMap = useMemo(() => buildHeaderMap(columns), [columns]);

  const errByRow = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of errors) m.set(e.row, e.message);
    return m;
  }, [errors]);

  /** 前端自检：空行 + 同批重复（不查库） */
  const special = useMemo(() => mapSpecialRows(rows, columns), [rows, columns]);
  const blocked = errors.length > 0 || special.dupCount > 0;

  const reset = useCallback(() => {
    setRows([]);
    setErrors([]);
    setFileName('');
    setStep(0);
    setResult(null);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
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
        const mapped = mapRows(raw, headerMap);
        setRows(mapped);
        setErrors([]);
        setStep(2);

        // 立即做一次不查库的基础校验，让用户先看到格式问题
        const r = await importApi.preview({ kind, rows: mapped });
        setErrors(r.errors ?? []);
      } catch (e: any) {
        message.error(`文件解析失败：${e.message}`);
      }
    },
    [headerMap, kind],
  );

  const execute = useCallback(async () => {
    if (rows.length === 0) return message.warning('请先选择文件');
    setSubmitting(true);
    try {
      const r = await importApi.execute({ kind, fileName, rows });
      setResult(r);
      setErrors(r.errors ?? []);
      setStep(3);
      if (r.failed === 0) message.success(`导入成功 ${r.success} 行`);
      else message.warning(`导入失败 ${r.failed} 行，已整批回滚，请修正后重试`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }, [rows, kind, fileName]);

  const downloadTemplate = useCallback(() => {
    if (!def) return;
    const ws = XLSX.utils.aoa_to_sheet([templateHeader(columns)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '模板');
    XLSX.writeFile(wb, `${def.name}_导入模板.xlsx`);
  }, [def, columns]);

  // 注意：所有 Hook 都在上面调用完毕，下面才能安全地做条件渲染
  return (
    <div style={{ padding: '4px 0 8px' }}>
      <ImportHeroHeader
        kindName={def?.name ?? '导入'}
        hint={def?.hint}
        rowCount={rows.length}
        errorCount={errors.length + special.dupCount}
      />

      <Card
        style={{ borderRadius: 14, boxShadow: '0 2px 12px -6px rgba(0,0,0,0.12)' }}
        styles={{ body: { padding: '18px 20px' } }}
      >
        <Steps size="small" current={step} items={STEP_ITEMS} style={{ marginBottom: 20 }} />

        <Space wrap size={12} style={{ marginBottom: 16 }}>
          <span style={{ color: '#555' }}>导入类型</span>
          <Select
            value={kind}
            onChange={(v) => {
              setKind(v);
              reset();
            }}
            style={{ minWidth: 180 }}
            options={kinds.map((k) => ({ value: k.kind, label: k.name }))}
          />
          <Button onClick={downloadTemplate}>下载模板</Button>
          {step >= 2 && (
            <Button
              type="primary"
              disabled={rows.length === 0 || blocked}
              loading={submitting}
              onClick={execute}
            >
              确认导入{rows.length > 0 ? `（${rows.length} 行）` : ''}
            </Button>
          )}
          {step > 0 && <Button onClick={reset}>重新选择</Button>}
        </Space>

        {blocked && step === 2 && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`有 ${errors.length + special.dupCount} 处问题需要修正，修正后才能导入`}
          />
        )}

        {/* 第 2 步：上传 */}
        {step <= 1 && (
          <Upload.Dragger
            accept=".xlsx,.xls,.csv"
            showUploadList={false}
            beforeUpload={(file) => {
              void handleFile(file as unknown as File);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined style={{ color: '#4f46e5' }} />
            </p>
            <p className="ant-upload-text">点击或拖拽文件到此处</p>
            <p className="ant-upload-hint">支持 .xlsx / .xls / .csv，首行需为表头</p>
          </Upload.Dragger>
        )}

        {/* 第 3 步：预览校验 */}
        {step === 2 && (
          <ImportPreviewTable
            columns={columns}
            rows={rows}
            errByRow={errByRow}
            emptyRows={special.empty}
            duplicated={special.duplicated}
          />
        )}

        {/* 第 4 步：结果 */}
        {step === 3 && result && (
          <ImportResultPanel
            total={result.total}
            success={result.success}
            failed={result.failed}
            errors={result.errors ?? []}
            skippedEmpty={special.empty.length}
          />
        )}
      </Card>

      {step === 0 && (
        <Row gutter={12} style={{ marginTop: 14 }}>
          <Col xs={24} sm={12}>
            <Card size="small" style={{ borderRadius: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>导入前请确认</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: '#555', lineHeight: 1.9 }}>
                <li>首行必须是表头，中文表头或英文字段名都可以</li>
                <li>必填列不能留空，编码类字段不可重复</li>
                <li>任一行出错会整批回滚，不会写进一半</li>
              </ul>
            </Card>
          </Col>
          <Col xs={24} sm={12}>
            <Card size="small" style={{ borderRadius: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                <CloudUploadOutlined style={{ color: '#4f46e5', marginRight: 6 }} />
                还没有模板？
              </div>
              <div style={{ color: '#555', lineHeight: 1.9, marginBottom: 10 }}>
                先下载当前类型的标准模板，按列填写后再上传，能避免绝大多数格式问题。
              </div>
              <Button size="small" type="primary" ghost onClick={downloadTemplate}>
                下载空白模板
              </Button>
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
}
