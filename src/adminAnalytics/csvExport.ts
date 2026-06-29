import type { AdminTradeRow } from './adminAnalyticsTypes.js';
import { CSV_TRADE_COLUMNS } from './adminAnalyticsTypes.js';
import { computeNotionalUsd } from './tradeAnalytics.js';

const escapeCsvCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export type CsvTradeExportRow = AdminTradeRow & {
  tenantId: string;
  tenantName: string;
  ownerEmail: string | null;
};

export const tradeRowToCsvRecord = (row: CsvTradeExportRow): Record<string, string | number | boolean | null> => ({
  timestamp: row.timestamp,
  tenant_id: row.tenantId,
  tenant_name: row.tenantName,
  owner_email: row.ownerEmail,
  trade_id: row.id,
  status: row.status,
  success: row.success,
  market_id: row.marketId,
  market_title: row.marketTitle,
  outcome: row.outcome,
  side: row.side,
  amount: row.amount,
  price: row.price,
  notional_usd: row.notionalUsd || computeNotionalUsd(row.amount, row.price),
  source_wallet: row.sourceWallet,
  source_wallet_label: row.sourceWalletLabel,
  execution_time_ms: row.executionTimeMs,
  error: row.error,
  order_id: row.orderId,
  detected_tx_hash: row.detectedTxHash,
  token_id: row.tokenId,
});

export const formatCsvHeader = (): string => CSV_TRADE_COLUMNS.join(',');

export const formatCsvRow = (row: CsvTradeExportRow): string => {
  const record = tradeRowToCsvRecord(row);
  return CSV_TRADE_COLUMNS.map((col) => escapeCsvCell(record[col])).join(',');
};

export const formatCsvContent = (rows: CsvTradeExportRow[]): string => {
  const lines = [formatCsvHeader(), ...rows.map(formatCsvRow)];
  return `${lines.join('\n')}\n`;
};
