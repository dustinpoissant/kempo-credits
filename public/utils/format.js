/*
  Words and numbers for the screens, served at /credits/utils/format.js.

  Money goes through kempo-payments' own formatter, so a pack priced in yen is never shown as
  hundredths of a yen.
*/

export { formatAmount, toMinor, fromMinor, decimalsFor } from '/payments/utils/money.js';

const number = new Intl.NumberFormat();

export const formatCredits = credits => number.format(Number(credits) || 0);

export const plural = (count, one, many = `${one}s`) => `${formatCredits(count)} ${Math.abs(count) === 1 ? one : many}`;

export const formatDate = value => value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

export const formatDateTime = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

/*
  What each ledger entry type is called on a screen, for the person whose credits they are.
*/
export const ENTRY_LABELS = {
  grant: 'Added',
  spend: 'Spent',
  reversal: 'Returned',
  clawback: 'Refunded',
  shortfall: 'Owed after refund',
  settlement: 'Applied to amount owed',
  removal: 'Removed',
  forgiveness: 'Written off',
  expiry: 'Expired',
};

export const entryLabel = type => ENTRY_LABELS[type] || type;

export const PURCHASE_LABELS = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
  failed: 'Failed',
  canceled: 'Cancelled',
  blocked: 'Blocked',
};

export const purchaseLabel = status => PURCHASE_LABELS[status] || status;

export const purchaseTone = status => {
  if(status === 'paid') return 'success';
  if(status === 'blocked' || status === 'failed') return 'danger';
  if(status === 'refunded' || status === 'partially_refunded') return 'warning';
  return 'muted';
};

export const BLOCK_REASONS = {
  'user-rate': 'Too many attempts from this account',
  'ip-rate': 'Too many attempts from this address',
  'global-rate': 'Site-wide limit reached',
  'user-declines': 'Too many declines on this account',
  'ip-declines': 'Too many declines from this address',
};

export const blockReason = reason => BLOCK_REASONS[reason] || reason || '';

export const signed = amount => `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${formatCredits(Math.abs(amount))}`;
