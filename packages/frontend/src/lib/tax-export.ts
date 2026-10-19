export interface TaxTransaction {
  date: string;
  type: string;
  amount: number;
  asset: string;
  description: string;
}

export interface TaxExportOptions {
  format: 'csv' | 'json';
  startDate?: string;
  endDate?: string;
}

export function exportTaxData(transactions: TaxTransaction[], options: TaxExportOptions): string {
  const filtered = transactions.filter(t => {
    if (options.startDate && t.date < options.startDate) return false;
    if (options.endDate && t.date > options.endDate) return false;
    return true;
  });

  if (options.format === 'json') {
    return JSON.stringify(filtered, null, 2);
  }

  const headers = ['Date', 'Type', 'Amount', 'Asset', 'Description'];
  const rows = filtered.map(t => [t.date, t.type, t.amount.toString(), t.asset, t.description.replace(/,/g, ';')]);
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

export function downloadTaxData(transactions: TaxTransaction[], options: TaxExportOptions): void {
  const data = exportTaxData(transactions, options);
  const blob = new Blob([data], { type: options.format === 'csv' ? 'text/csv' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tax-report.${options.format}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}