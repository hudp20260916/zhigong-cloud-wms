import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Space, Steps, Upload, message } from 'antd';
import { CloudDownloadOutlined, ImportOutlined, InboxOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { importApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { ImportPreviewTable } from '../features/system/parts/ImportPreviewTable';
import { ImportResultPanel } from '../features/system/parts/ImportResultPanel';
import { buildHeaderMap, mapRows, mapSpecialRows, templateHeader } from '../features/system/parts/utils';

/**
 * 档案/业务页面内嵌的 Excel 导入入口。
 *
 * 与「系统设置 → Excel 导入」整页用的是同一套后端接口和同一套预览组件，
 * 区别只在于：
 *  1. kind 由调用方预设，页面里不再出现「选择类型」下拉；
 *  2. 步骤从四步简化为三步（上传 → 预览校验 → 完成）；
 *  3. 装进 Modal，不打断当前列表页的上下文。
 *
 * 解析在前端（选完文件就能逐行核对），唯一性/外键校验与落库仍在服务端整批事务里，
 * 任一行出错整批回滚 —— 这条行为与整页导入完全一致，不要在这里改。
 */
export interface ImportExcelModalProps {
  /** 后端 IMPORT_KINDS 里的 kind，如 material / supplier / customer / initial_stock */
  kind: string;
  /** 按钮文字，默认「导入 Excel」 */
  text?: string;
  /** 导入成功后的回调（一般用来刷新列表） */
  onSuccess?: () => void;
}

const STEP_ITEMS = [{ title: '上传文件' }, { title: '预览校验' }, { title: '完成' }];

export default function ImportExcelModal({ kind, text = '导入 Excel', onSuccess }: ImportExcelModalProps) {
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [fileName, setFileName] = useState('');
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const hasPerm = useAuthStore((s) => s.has);

  // 每次打开时取一次模板定义（列定义可能随后端版本变化，不做长期缓存）
  useEffect(() => {
    if (!open) return;
    importApi
      .kinds()
      .then(setKinds)
      .catch((e: any) => message.error(e.message));
  }, [open]);

  const def = useMemo(() => kinds.find((k) => k.kind === kind), [kinds, kind]);
  const columns = useMemo(() => def?.columns ?? [], [def]);
  const headerMap = useMemo(() => buildHeaderMap(columns), [columns]);

  const errByRow = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of errors) m.set(e.row, e.message);
    return m;
  }, [errors]);

  /** 前端自检：整行空行 + 同批重复编码（不查库） */
  const special = useMemo(() => mapSpecialRows(rows, columns), [rows, columns]);
  const blocked = errors.length > 0 || special.dupCount > 0;

  const reset = useCallback(() => {
    setRows([]);
    setErrors([]);
    setFileName('');
    setStep(0);
    setResult(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

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
        setStep(1);

        // 先做一次不查库的基础校验，让用户立刻看到格式问题
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
      setStep(2);
      if (r.failed === 0) {
        message.success(`导入成功 ${r.success} 行`);
        onSuccess?.();
      } else {
        message.warning(`导入失败 ${r.failed} 行，已整批回滚，请修正后重试`);
      }
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }, [rows, kind, fileName, onSuccess]);

  const downloadTemplate = useCallback(() => {
    if (!def) return message.warning('模板定义尚未加载完成');
    const ws = XLSX.utils.aoa_to_sheet([templateHeader(columns)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '模板');
    XLSX.writeFile(wb, `${def.name}_导入模板.xlsx`);
  }, [def, columns]);

  // 所有 Hook 都在上面调用完毕，这里才能安全地做条件返回。
  // 无导入权限时整个入口不渲染，行为与 PermGate 一致：不给「看得见点不动」的按钮。
  if (!hasPerm('system.import.execute')) return null;

  return (
    <>
      <Button icon={<ImportOutlined />} onClick={() => setOpen(true)}>
        {text}
      </Button>

      <Modal
        open={open}
        onCancel={close}
        width={900}
        destroyOnClose
        maskClosable={false}
        title={`${def?.name ?? ''} · Excel 导入`}
        footer={[
          <Button key="tpl" icon={<CloudDownloadOutlined />} onClick={downloadTemplate}>
            下载导入模板
          </Button>,
          step === 1 ? (
            <Button
              key="go"
              type="primary"
              disabled={rows.length === 0 || blocked}
              loading={submitting}
              onClick={execute}
            >
              确认导入{rows.length > 0 ? `（${rows.length} 行）` : ''}
            </Button>
          ) : null,
          step > 0 ? (
            <Button key="reset" onClick={reset}>
              重新选择
            </Button>
          ) : null,
          <Button key="close" onClick={close}>
            关闭
          </Button>,
        ]}
      >
        <Steps size="small" current={step} items={STEP_ITEMS} style={{ margin: '4px 0 18px' }} />

        {def?.hint && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            message={<span style={{ fontSize: 12 }}>{def.hint}</span>}
          />
        )}

        {blocked && step === 1 && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`有 ${errors.length + special.dupCount} 处问题需要修正，修正后才能导入`}
          />
        )}

        {step === 0 && (
          <>
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
            <Space style={{ marginTop: 12 }}>
              <Button size="small" type="primary" ghost icon={<CloudDownloadOutlined />} onClick={downloadTemplate}>
                还没有模板？下载空白模板
              </Button>
            </Space>
          </>
        )}

        {step === 1 && (
          <ImportPreviewTable
            columns={columns}
            rows={rows}
            errByRow={errByRow}
            emptyRows={special.empty}
            duplicated={special.duplicated}
          />
        )}

        {step === 2 && result && (
          <ImportResultPanel
            total={result.total}
            success={result.success}
            failed={result.failed}
            errors={result.errors ?? []}
            skippedEmpty={special.empty.length}
          />
        )}
      </Modal>
    </>
  );
}
