import { useRef, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  InputNumber,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { archiveApi, purchaseApi } from '../../api';
import { ResponsiveTable, Modal } from '../../components';

export interface OcrDraft {
  requestId: string;
  supplierId?: number | null;
  lines: {
    materialId?: number | null;
    materialName: string;
    materialCode: string;
    spec: string;
    unit: string;
    qty: number;
    price: number;
    confidence: number;
  }[];
}

/**
 * OCR 建单。
 *
 * 定位：**识别结果永远只是草稿**。这里只做「上传 -> 识别 -> 人工修正 -> 回填建单表单」，
 * 真正的库存变更仍由采购入库的建单接口完成，库存依旧只经 ledger 变更。
 * 识别请求号会被带回，落库时写入 ocr_logs，便于统计识别采纳率。
 */
export default function OcrImportModal({
  open,
  onCancel,
  onApply,
}: {
  open: boolean;
  onCancel: () => void;
  onApply: (draft: OcrDraft) => void;
}) {
  const [materials, setMaterials] = useState<any[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [requestId, setRequestId] = useState('');
  const [lines, setLines] = useState<any[]>([]);
  const [preview, setPreview] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);
  const loaded = useRef(false);

  if (!loaded.current) {
    loaded.current = true;
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
  }

  async function recognize(file: File) {
    setRecognizing(true);
    setResult(null);
    setLines([]);
    try {
      const base64 = await toBase64(file);
      setPreview(base64);
      const r = await purchaseApi.ocrRecognize({
        fileName: file.name,
        mimeType: file.type || 'image/jpeg',
        contentBase64: base64,
      });
      setRequestId(r.requestId);
      setResult(r.result);
      setLines(
        (r.result.lines ?? []).map((l: any, i: number) => ({
          key: `ocr-${i}`,
          materialId: l.materialId,
          materialCode: l.materialCode,
          materialName: l.materialName,
          spec: l.spec,
          unit: l.unit,
          qty: l.qty,
          price: l.price,
          confidence: l.confidence,
        })),
      );
      setElapsed(r.durationMs);
      if ((r.result.lines ?? []).length === 0) {
        message.warning('未识别到明细行，请手动录入');
      }
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRecognizing(false);
    }
  }

  function apply() {
    const valid = lines.filter((l) => l.materialId && l.qty > 0);
    if (valid.length === 0) return message.warning('请至少保留一行有效的识别结果');
    onApply({
      requestId,
      supplierId: result?.supplierId ?? null,
      lines: valid.map((l) => ({
        materialId: l.materialId,
        materialName: l.materialName,
        materialCode: l.materialCode,
        spec: l.spec,
        unit: l.unit,
        qty: Number(l.qty),
        price: Number(l.price ?? 0),
        confidence: l.confidence,
      })),
    });
  }

  return (
    <Modal
      open={open}
      title="OCR 识别建单"
      onCancel={onCancel}
      width={900}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="ok" type="primary" disabled={lines.length === 0} onClick={apply}>
          填入入库单（{lines.filter((l) => l.materialId && l.qty > 0).length} 行）
        </Button>,
      ]}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="识别结果仅供参考，请人工核对数量与单价后再提交入库"
        description="当前为内置演示识别器；接入真实 OCR 服务时只需替换服务端 core/ocr.ts 的 callProvider()，本页无需改动。"
      />

      <Upload.Dragger
        accept="image/*,application/pdf"
        showUploadList={false}
        beforeUpload={(file) => {
          recognize(file as unknown as File);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点击或拖拽送货单照片到此处</p>
        <p className="ant-upload-hint">支持 jpg / png / webp / bmp / pdf，单文件不超过 4MB</p>
      </Upload.Dragger>

      {recognizing && (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin tip="识别中…" />
        </div>
      )}

      {result && (
        <>
          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered style={{ marginTop: 12 }}>
            <Descriptions.Item label="识别供应商">{result.supplierName || '—'}</Descriptions.Item>
            <Descriptions.Item label="单据日期">{result.docDate || '—'}</Descriptions.Item>
            <Descriptions.Item label="耗时">{elapsed} ms</Descriptions.Item>
          </Descriptions>

          {result.warnings?.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="需要人工复核"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.warnings.map((w: string, i: number) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              }
            />
          )}

          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            {preview && (
              <img
                src={preview}
                alt="识别原图"
                style={{
                  width: 200,
                  maxHeight: 220,
                  objectFit: 'contain',
                  border: '1px solid #f0f0f0',
                  borderRadius: 6,
                  background: '#fafafa',
                }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <ResponsiveTable
                size="small"
                rowKey="key"
                dataSource={lines}
                pagination={false}
                scroll={{ y: 220, x: 640 }}
                columns={[
                  {
                    title: '物料',
                    width: 220,
                    render: (_v, r) => (
                      <Select
                        size="small"
                        showSearch
                        style={{ width: '100%' }}
                        value={r.materialId ?? undefined}
                        optionFilterProp="label"
                        placeholder="选择物料"
                        onChange={(v) =>
                          setLines((prev) =>
                            prev.map((x) =>
                              x.key === r.key
                                ? {
                                    ...x,
                                    materialId: v,
                                    ...pickMaterial(materials, v),
                                  }
                                : x,
                            ),
                          )
                        }
                        options={materials.map((m: any) => ({
                          value: m.id,
                          label: `${m.code} ${m.name}`,
                        }))}
                      />
                    ),
                  },
                  {
                    title: '置信度',
                    dataIndex: 'confidence',
                    width: 90,
                    render: (v) => (
                      <Tag color={Number(v) >= 0.85 ? 'green' : 'orange'}>
                        {Math.round(Number(v) * 100)}%
                      </Tag>
                    ),
                  },
                  { title: '单位', dataIndex: 'unit', width: 60 },
                  {
                    title: '数量',
                    dataIndex: 'qty',
                    width: 110,
                    render: (v, r) => (
                      <InputNumber
                        size="small"
                        min={0}
                        style={{ width: '100%' }}
                        value={v}
                        onChange={(nv) =>
                          setLines((prev) =>
                            prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)),
                          )
                        }
                      />
                    ),
                  },
                  {
                    title: '单价',
                    dataIndex: 'price',
                    width: 110,
                    render: (v, r) => (
                      <InputNumber
                        size="small"
                        min={0}
                        precision={2}
                        style={{ width: '100%' }}
                        value={v}
                        onChange={(nv) =>
                          setLines((prev) =>
                            prev.map((x) => (x.key === r.key ? { ...x, price: Number(nv ?? 0) } : x)),
                          )
                        }
                      />
                    ),
                  },
                  {
                    title: '操作',
                    width: 60,
                    render: (_, r) => (
                      <Button
                        type="link"
                        size="small"
                        danger
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== r.key))}
                      >
                        移除
                      </Button>
                    ),
                  },
                ]}
              />
            </div>
          </div>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            请求号 {requestId}
          </Typography.Text>
          <Space style={{ marginTop: 8 }} />
        </>
      )}
    </Modal>
  );
}

function pickMaterial(materials: any[], id: number | undefined) {
  const m = materials.find((x) => x.id === id);
  if (!m) return {};
  return {
    materialCode: m.code,
    materialName: m.name,
    spec: m.spec ?? '',
    unit: m.unit,
  };
}

/** File -> data URL，直接作为 img src 使用，同时其 base64 部分用于上传 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}
