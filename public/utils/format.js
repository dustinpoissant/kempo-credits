/*
  Words and numbers for the screens, served at /credits/utils/format.js.

  Credits are whole numbers and have no currency, so nothing here deals in money.
*/

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
  clawback: 'Taken back',
  shortfall: 'Owed after a refund',
  forfeit: 'Could not be taken back',
  settlement: 'Applied to amount owed',
  removal: 'Removed',
  forgiveness: 'Written off',
  transfer_out: 'Sent',
  transfer_in: 'Received',
};

export const entryLabel = type => ENTRY_LABELS[type] || type;

export const signed = amount => `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${formatCredits(Math.abs(amount))}`;

/*
  A kind is a lowercase label (`general`, `achievement`, `purchase`); shown with its first letter up
  and its separators as spaces.
*/
export const kindLabel = kind => {
  const text = String(kind || 'general').replace(/[-_]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
