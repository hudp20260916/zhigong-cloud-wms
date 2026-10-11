-- 需求 29：单据前缀可在系统参数里改，序号必须继续递增而不是从头开始。
-- 因此序列记录从「按前缀」改为「按单据类型」定位：改前缀只改展示用的前缀列，
-- 序号仍跟在原来的计数后面走，不会出现改前缀后单号撞车。

ALTER TABLE code_sequences ADD COLUMN kind TEXT;

-- 回填老库：按系统默认前缀反查单据类型
UPDATE code_sequences SET kind = 'purchaseOrder'   WHERE kind IS NULL AND prefix = 'PO';
UPDATE code_sequences SET kind = 'purchaseReceipt' WHERE kind IS NULL AND prefix = 'PR';
UPDATE code_sequences SET kind = 'purchaseReturn'  WHERE kind IS NULL AND prefix = 'RT';
UPDATE code_sequences SET kind = 'workOrder'       WHERE kind IS NULL AND prefix = 'WO';
UPDATE code_sequences SET kind = 'issue'           WHERE kind IS NULL AND prefix = 'MI';
UPDATE code_sequences SET kind = 'productReceipt'  WHERE kind IS NULL AND prefix = 'FG';
UPDATE code_sequences SET kind = 'saleOrder'       WHERE kind IS NULL AND prefix = 'SO';
UPDATE code_sequences SET kind = 'saleDelivery'    WHERE kind IS NULL AND prefix = 'SD';
UPDATE code_sequences SET kind = 'saleReturn'      WHERE kind IS NULL AND prefix = 'SR';
UPDATE code_sequences SET kind = 'stockCheck'      WHERE kind IS NULL AND prefix = 'SC';
UPDATE code_sequences SET kind = 'materialSale'    WHERE kind IS NULL AND prefix = 'MS';
UPDATE code_sequences SET kind = 'defectiveOut'    WHERE kind IS NULL AND prefix = 'DO';
UPDATE code_sequences SET kind = 'simulate'        WHERE kind IS NULL AND prefix = 'SM';
UPDATE code_sequences SET kind = 'settlement'      WHERE kind IS NULL AND prefix = 'ST';

CREATE UNIQUE INDEX IF NOT EXISTS idx_code_sequences_kind ON code_sequences (kind) WHERE kind IS NOT NULL;
