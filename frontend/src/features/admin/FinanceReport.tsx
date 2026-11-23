import { useCallback, useState } from 'react';
import { ErrorMessage } from '../../components/ui/Feedback';
import { TextField } from '../../components/ui/Form';
import { Spinner } from '../../components/ui/Spinner';
import { StatGrid } from '../../components/ui/Stats';
import { toErrorMessage } from '../../lib/apiClient';
import { formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { DashboardApi } from '../dashboard/dashboardApi';

/**
 * Platform finance for a period. Platform charges are TicketFlow revenue; VAT is a tax
 * liability shown on its own and never added to revenue; ticket sales belong to organizers.
 */
export function FinanceReport({ api }: { api: DashboardApi }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const reversed = Boolean(from && to && from > to);
  // A reversed range keeps showing the last valid query instead of requesting a 400.
  const queryFrom = reversed ? '' : from;
  const queryTo = reversed ? '' : to;
  const range = reversed ? null : { from, to };
  const report = useAsync(
    useCallback(
      (signal: AbortSignal) =>
        api.adminFinance(
          { ...(queryFrom ? { from: queryFrom } : {}), ...(queryTo ? { to: queryTo } : {}) },
          signal,
        ),
      [api, queryFrom, queryTo],
    ),
    `${queryFrom}:${queryTo}`,
  );

  return (
    <section className="card" aria-labelledby="finance-heading">
      <h2 id="finance-heading">Finance</h2>
      <div className="filters">
        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {!range && <p className="alert alert--error">“From” must not be after “To”.</p>}
      {report.status === 'loading' && <Spinner label="Loading finance report" />}
      {report.status === 'error' && (
        <ErrorMessage message={toErrorMessage(report.error)} onRetry={report.reload} />
      )}
      {report.status === 'success' &&
        (() => {
          const d = report.data;
          const money = (minor: number) => formatMoney(minor, d.currency);
          return (
            <>
              <StatGrid
                label="Platform finance"
                stats={[
                  {
                    label: 'Net platform revenue',
                    value: money(d.platformRevenue.netMinor),
                    hint: `${money(d.platformRevenue.grossMinor)} platform charges, ${money(d.platformRevenue.refundedMinor)} refunded`,
                  },
                  {
                    label: 'VAT collected (tax liability)',
                    value: money(d.vatLiability.netMinor),
                    hint: `${money(d.vatLiability.collectedMinor)} collected, ${money(d.vatLiability.refundedMinor)} refunded · not revenue`,
                  },
                  {
                    label: 'Ticket sales (organizers)',
                    value: money(d.ticketSales.netMinor),
                    hint: `${money(d.ticketSales.grossMinor)} sold, ${money(d.ticketSales.refundedMinor)} refunded`,
                  },
                  {
                    label: 'Customer payments',
                    value: money(d.customerPaymentsMinor),
                    hint: `${d.payments} payment(s)`,
                  },
                  {
                    label: 'Refunds',
                    value: money(d.refundedTotalMinor),
                    hint: `${d.refunds} refund(s)`,
                  },
                ]}
              />
              <p className="field__hint">
                Customer payments = ticket sales + platform charges + VAT. VAT is collected for the
                tax authority and is excluded from platform revenue.
              </p>
            </>
          );
        })()}
    </section>
  );
}
