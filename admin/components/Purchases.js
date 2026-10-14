import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { clawBackLot, getPurchase, getSummary, listPurchases, newKey, reconcilePurchase } from '/credits/sdk.js';
import {
  blockReason, entryLabel, formatAmount, formatCredits, formatDateTime, purchaseLabel, purchaseTone, signed,
} from '/credits/utils/format.js';
import permissions from '/admin/extension/kempo-credits/components/permissions.js';

/*
  Every purchase, and the attempts that were refused before they became one.

  "Blocked" is the abuse log: attempts the rate limits or the decline cool-down turned away, with the
  reason and the address they came from. A sudden run of those is card testing, and this is where it
  shows up before the processor's bill does.

  A purchase opens onto everything behind it — what the buyer was shown before paying, the payment as
  the processor reported it, and the lot it granted with every change since — so a dispute or a "I
  paid and got nothing" is answered from one screen.

  `status` and `purchase-id` open it pre-filtered or on one purchase, which is how notifications link
  here.
*/

const PAGE = 25;

const FILTERS = [
  { value: '', label: 'All purchases' },
  { value: 'paid', label: 'Paid' },
  { value: 'pending', label: 'Awaiting payment' },
  { value: 'refunded,partially_refunded', label: 'Refunded' },
  { value: 'failed,canceled', label: 'Failed and cancelled' },
  { value: 'blocked', label: 'Blocked attempts' },
];

export default class Purchases extends ShadowComponent {
  static properties = {
    status: { type: String },
    purchaseId: { type: String, attribute: 'purchase-id' },
    purchases: { type: Array, state: true },
    total: { type: Number, state: true },
    offset: { type: Number, state: true },
    summary: { type: Object, state: true },
    detail: { type: Object, state: true },
    allowed: { type: Object, state: true },
    clawing: { type: Boolean, state: true },
    note: { type: String, state: true },
    busy: { type: Boolean, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
    notice: { type: String, state: true },
  };

  #key = null;
  #opened = '';

  constructor(){
    super();
    this.status = '';
    this.purchaseId = '';
    this.purchases = [];
    this.total = 0;
    this.offset = 0;
    this.summary = null;
    this.detail = null;
    this.allowed = new Set();
    this.clawing = false;
    this.note = '';
    this.busy = false;
    this.loading = true;
    this.error = '';
    this.notice = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    permissions().then(allowed => { this.allowed = allowed; });
    if(this.purchaseId) this.open(this.purchaseId);
    this.load();
  }

  /*
    The page sets `purchaseId` or `status` from its URL after this has connected.
  */
  updated(changed){
    super.updated?.(changed);
    if(changed.has('purchaseId') && this.purchaseId && this.#opened !== this.purchaseId) this.open(this.purchaseId);
    if(changed.has('status') && changed.get('status') !== undefined) this.load();
  }

  /*
    Data
  */

  load = async () => {
    this.loading = true;
    const [[error, data], [, summary]] = await Promise.all([
      listPurchases({ status: this.status || undefined, limit: PAGE, offset: this.offset }),
      getSummary(),
    ]);
    this.loading = false;
    this.error = error ? error.msg : '';
    this.purchases = data?.purchases || [];
    this.total = data?.total || 0;
    this.summary = summary?.purchases || null;
  };

  filter = event => {
    this.status = event.target.value;
    this.offset = 0;
    this.load();
  };

  page = delta => {
    this.offset = Math.max(0, this.offset + delta * PAGE);
    this.load();
  };

  open = async id => {
    this.#opened = id;
    this.purchaseId = id;
    this.detail = null;
    this.clawing = false;
    this.notice = '';
    const [error, data] = await getPurchase(id);
    this.error = error ? error.msg : '';
    this.detail = data || null;
  };

  close = () => {
    this.#opened = '';
    this.purchaseId = '';
    this.detail = null;
    this.load();
  };

  /*
    Actions
  */

  recheck = async () => {
    this.busy = true;
    const [error] = await reconcilePurchase(this.purchaseId);
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    await this.open(this.purchaseId);
    this.notice = 'Checked with the payment processor.';
  };

  startClawBack = () => {
    this.clawing = true;
    this.note = '';
    this.#key = newKey();
  };

  clawBack = async event => {
    event.preventDefault();
    this.busy = true;
    const [error, result] = await clawBackLot(this.detail.purchase.lotId, { note: this.note, idempotencyKey: this.#key });
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.clawing = false;
    await this.open(this.purchaseId);
    this.notice = result.shortfall
      ? `Took back ${formatCredits(result.taken)}. ${formatCredits(result.shortfall)} had already been spent and is now owed.`
      : `Took back ${formatCredits(result.taken)} credits.`;
  };

  /*
    Rendering
  */

  #renderTiles(){
    if(!this.summary) return nothing;
    return html`
      <div class="d-f tiles">
        ${this.summary.sales.map(sale => html`
          <div class="card tile">
            <span class="tc-muted">Sold in ${this.summary.days} days (${sale.currency.toUpperCase()})</span>
            <span class="value">${formatAmount(sale.total - sale.refunded, sale.currency)}</span>
            <span class="tc-muted">${sale.count} purchase${sale.count === 1 ? '' : 's'} · ${formatCredits(sale.credits)} credits</span>
          </div>
        `)}
        <div class="card tile">
          <span class="tc-muted">Blocked in the last day</span>
          <span class="value ${this.summary.blockedLastDay ? 'tc-warning' : ''}">${this.summary.blockedLastDay}</span>
          <span class="tc-muted">Refused by the rate limits or the decline cool-down</span>
        </div>
        ${this.summary.needsAttention ? html`
          <div class="card tile">
            <span class="tc-muted">Need a look</span>
            <span class="value tc-danger">${this.summary.needsAttention}</span>
            <span class="tc-muted">Disputed, refunded after spending, or missing from the tax ledger</span>
          </div>
        ` : nothing}
      </div>
    `;
  }

  #renderList(){
    if(this.loading && !this.purchases.length) return html`<k-spinner></k-spinner>`;
    if(!this.purchases.length) return html`<p class="tc-muted">${this.status ? 'Nothing matches that filter.' : 'Nobody has bought any credits yet.'}</p>`;
    const blocked = this.status === 'blocked';

    return html`
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>When</th><th>Buyer</th>
              ${blocked ? html`<th>Why it was refused</th><th>Address</th>` : html`<th>Pack</th><th class="ta-right">Total</th><th>Status</th>`}
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${this.purchases.map(purchase => html`
              <tr @click=${() => this.open(purchase.id)}>
                <td>${formatDateTime(purchase.createdAt)}</td>
                <td class="ff-mono">${purchase.userId}</td>
                ${blocked ? html`
                  <td>${blockReason(purchase.blockedReason)}</td>
                  <td class="ff-mono">${purchase.ip || '—'}</td>
                ` : html`
                  <td>${formatCredits(purchase.credits)} <span class="tc-muted">${purchase.packName || ''}</span></td>
                  <td class="ta-right">${purchase.currency ? formatAmount(purchase.total, purchase.currency) : '—'}</td>
                  <td>
                    <span class="tc-${purchaseTone(purchase.status)}">${purchaseLabel(purchase.status)}</span>
                    ${purchase.status === 'blocked' ? html`<span class="d-b tc-muted">${blockReason(purchase.blockedReason)}</span>` : nothing}
                    ${purchase.disputed ? html`<span class="d-b tc-danger">Disputed</span>` : nothing}
                    ${purchase.shortfall ? html`<span class="d-b tc-danger">${formatCredits(purchase.shortfall)} owed after refund</span>` : nothing}
                    ${purchase.taxError ? html`<span class="d-b tc-danger">Tax not recorded</span>` : nothing}
                  </td>
                `}
                <td><button class="link">Open</button></td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      ${this.total > PAGE ? html`
        <div class="d-f pager">
          <button ?disabled=${this.offset === 0} @click=${() => this.page(-1)}>Newer</button>
          <span class="tc-muted">${this.offset + 1}–${Math.min(this.offset + PAGE, this.total)} of ${this.total}</span>
          <button ?disabled=${this.offset + PAGE >= this.total} @click=${() => this.page(1)}>Older</button>
        </div>
      ` : nothing}
    `;
  }

  #renderDetail(){
    if(!this.detail) return this.error ? html`<p class="tc-danger">${this.error}</p>` : html`<k-spinner></k-spinner>`;
    const { purchase, user, payment, lot } = this.detail;
    const shown = purchase.shown;
    const canAdjust = this.allowed.has('credits:adjust');

    return html`
      <h2 class="mb0">${purchase.status === 'blocked' ? 'Blocked attempt' : `${formatCredits(purchase.credits)} credits`}</h2>
      <p class="tc-muted"><span class="ff-mono">${purchase.id}</span> · ${formatDateTime(purchase.createdAt)}</p>

      ${this.notice ? html`<p class="tc-success" role="status">${this.notice}</p>` : nothing}
      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}

      <div class="row -mx">
        <div class="span-6 m-span-12 px">
          <div class="card">
            <p class="mb0"><strong>Buyer</strong></p>
            <p>${user ? html`${user.name} <span class="tc-muted d-b">${user.email}</span>` : html`<span class="ff-mono">${purchase.userId}</span>`}</p>
            <p class="tc-muted mb0">From ${purchase.ip || 'an unknown address'}${purchase.userAgent ? html` · ${purchase.userAgent}` : nothing}</p>
          </div>
          <div class="card">
            <p class="mb0"><strong>Status</strong></p>
            <p class="tc-${purchaseTone(purchase.status)}">${purchaseLabel(purchase.status)}</p>
            ${purchase.blockedReason ? html`<p>${blockReason(purchase.blockedReason)}</p>` : nothing}
            ${purchase.failures ? html`<p>${purchase.failures} declined attempt${purchase.failures === 1 ? '' : 's'}</p>` : nothing}
            ${purchase.lastError ? html`<p class="tc-muted">${purchase.lastError}</p>` : nothing}
            ${purchase.refundedAmount ? html`<p>${formatAmount(purchase.refundedAmount, purchase.currency)} refunded · ${formatCredits(purchase.creditsClawedBack)} credits taken back</p>` : nothing}
            ${purchase.shortfall ? html`<p class="tc-danger">${formatCredits(purchase.shortfall)} of them had already been spent, and are owed.</p>` : nothing}
            ${purchase.disputed ? html`<p class="tc-danger">The buyer has disputed this payment. Nothing was taken back automatically.</p>` : nothing}
            ${purchase.taxError ? html`<p class="tc-danger">${purchase.taxError}</p>` : nothing}
            ${purchase.paymentId ? html`<button ?disabled=${this.busy} @click=${this.recheck}><k-icon name="replay"></k-icon> Check with the payment processor</button>` : nothing}
          </div>
        </div>

        <div class="span-6 m-span-12 px">
          ${shown ? html`
            <div class="card">
              <p class="mb0"><strong>What the buyer was shown</strong> <span class="tc-muted">${formatDateTime(shown.shownAt)}</span></p>
              <div class="mb">
                <div class="d-f mbq"><span class="flex">${shown.pack.name}</span><span>${formatCredits(shown.pack.credits)} credits</span></div>
                <div class="d-f mbq"><span class="flex">Price</span><span>${formatAmount(shown.subtotal, shown.currency)}</span></div>
                ${shown.taxed ? html`<div class="d-f mbq"><span class="flex">Tax${shown.includesTax ? ' (included)' : ''}</span><span>${formatAmount(shown.tax, shown.currency)}</span></div>` : nothing}
                <div class="d-f"><strong class="flex">Total</strong><strong>${formatAmount(shown.total, shown.currency)}</strong></div>
              </div>
              <p class="tc-muted mb0"><strong>Refund policy shown:</strong> ${shown.refundPolicy || 'none'}</p>
            </div>
          ` : nothing}
          ${payment ? html`
            <div class="card">
              <p class="mb0"><strong>Payment</strong> ${payment.livemode ? nothing : html`<span class="tc-muted">test mode</span>`}</p>
              <p>
                ${formatAmount(payment.amountCaptured || payment.amount, payment.currency)} · ${payment.status.replaceAll('_', ' ')}
                ${payment.amountRefunded ? html` · ${formatAmount(payment.amountRefunded, payment.currency)} refunded` : nothing}
              </p>
              <a href="/admin/extension/kempo-payments/">Open in Payments</a>
            </div>
          ` : nothing}
        </div>
      </div>

      ${lot ? html`
        <h3>The credits it granted</h3>
        <p>
          ${formatCredits(lot.amount)} ${lot.kind === 'paid' ? 'bought' : 'promo'} credits, ${formatCredits(lot.remaining)} left.
          ${canAdjust && lot.remaining > 0 ? html`<button class="link" @click=${this.startClawBack}>Claw them back</button>` : nothing}
        </p>
        ${this.clawing ? html`
          <form class="card" @submit=${this.clawBack}>
            <p class="tc-muted">Takes back what is left. Anything already spent is recorded as owed and stops the buyer spending until it is covered.</p>
            <label><span class="d-b">Why (required)</span>
              <input type="text" required maxlength="500" .value=${this.note} @input=${event => { this.note = event.target.value; }} />
            </label>
            <div class="d-f actions mb">
              <button class="danger" type="submit" ?disabled=${this.busy}>${this.busy ? 'Working…' : 'Claw back'}</button>
              <button type="button" @click=${() => { this.clawing = false; }}>Cancel</button>
            </div>
          </form>
        ` : nothing}
        <div class="table-wrapper">
          <table>
            <thead><tr><th>When</th><th>What</th><th class="ta-right">Credits</th><th>Why</th></tr></thead>
            <tbody>
              ${lot.entries.map(entry => html`
                <tr>
                  <td>${formatDateTime(entry.createdAt)}</td>
                  <td>${entryLabel(entry.type)}</td>
                  <td class="ta-right">${signed(entry.amount)}</td>
                  <td>${entry.reason || ''}${entry.referenceOwner && entry.type === 'spend' ? html` <span class="tc-muted">· ${entry.referenceOwner} ${entry.referenceId}</span>` : nothing}${entry.note ? html` <span class="tc-muted">· ${entry.note}</span>` : nothing}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      ` : nothing}
    `;
  }

  render(){
    if(this.purchaseId){
      return html`
        <button class="link mb" @click=${this.close}><k-icon name="arrow" direction="left"></k-icon> All purchases</button>
        ${this.#renderDetail()}
      `;
    }

    return html`
      ${this.#renderTiles()}
      <div class="d-f controls">
        <select .value=${this.status} @change=${this.filter}>
          ${FILTERS.map(option => html`<option value=${option.value} ?selected=${option.value === this.status}>${option.label}</option>`)}
        </select>
        <button @click=${this.load}><k-icon name="replay"></k-icon> Refresh</button>
        ${this.loading ? html`<k-spinner size="sm"></k-spinner>` : nothing}
      </div>
      ${this.error ? html`<p class="tc-danger">${this.error}</p>` : nothing}
      ${this.#renderList()}
    `;
  }

  static styles = css`
    :host { display: block; }
    .tiles, .controls, .pager, .actions { gap: var(--spacer); align-items: center; }
    .tile { display: flex; flex-direction: column; min-width: 13rem; }
    .tile .value { font-size: 1.6rem; line-height: 1.2; font-weight: 600; }
    .controls { margin-bottom: var(--spacer); }
    .controls select { margin: 0; max-width: 18rem; }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: var(--c_bg__alt); }
  `;
}

customElements.define('k-cred-purchases', Purchases);
