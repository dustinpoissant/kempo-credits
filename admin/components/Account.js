import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import {
  clawBackLot, forgiveDebt, getAccount, grantCredits, listAccountEntries, newKey, removeCredits, reverseOperation,
} from '/credits/sdk.js';
import { entryLabel, formatCredits, formatDate, formatDateTime, kindLabel, signed } from '/credits/utils/format.js';
import permissions from '/admin/extension/kempo-credits/components/permissions.js';

/*
  One user's credits, and exactly how they came to be.

  The lots are what they were granted; the ledger is every change to those lots, newest first. The
  audit line at the top is the proof that the two agree — it is worked out on the server from the
  entries, not taken from a stored total — so it is what to show somebody who says their balance is
  wrong.

  The corrections live here, each behind its own permission and each needing a note, because the
  note is what explains the entry to whoever reads this screen next: give credits
  (credits:grant); take credits away, write off what is owed, claw a grant back or reverse a spend
  (credits:adjust).
*/

const PAGE = 25;

const ACTIONS = {
  grant: { label: 'Give credits', permission: 'credits:grant', button: 'Give credits' },
  remove: { label: 'Take credits away', permission: 'credits:adjust', button: 'Take them away' },
  forgive: { label: 'Write off what is owed', permission: 'credits:adjust', button: 'Write it off' },
};

export default class Account extends ShadowComponent {
  static properties = {
    userId: { type: String, attribute: 'user-id' },
    open: { type: String },
    account: { type: Object, state: true },
    entries: { type: Array, state: true },
    actors: { type: Object, state: true },
    counterparties: { type: Object, state: true },
    entryTotal: { type: Number, state: true },
    offset: { type: Number, state: true },
    allowed: { type: Object, state: true },
    action: { type: String, state: true },
    target: { type: Object, state: true },
    form: { type: Object, state: true },
    busy: { type: Boolean, state: true },
    error: { type: String, state: true },
    notice: { type: String, state: true },
  };

  #key = null;

  constructor(){
    super();
    this.userId = '';
    this.open = '';
    this.account = null;
    this.entries = [];
    this.actors = {};
    this.counterparties = {};
    this.entryTotal = 0;
    this.offset = 0;
    this.allowed = new Set();
    this.action = '';
    this.target = null;
    this.form = {};
    this.busy = false;
    this.error = '';
    this.notice = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    permissions().then(allowed => { this.allowed = allowed; });
    if(ACTIONS[this.open]) this.openAction(this.open);
    this.load();
  }

  updated(changed){
    super.updated?.(changed);
    if(changed.has('userId') && changed.get('userId') !== undefined) this.load();
  }

  /*
    Data
  */

  load = async () => {
    if(!this.userId) return;
    const [[accountError, account], [entriesError, entries]] = await Promise.all([
      getAccount(this.userId),
      listAccountEntries(this.userId, { limit: PAGE, offset: this.offset }),
    ]);
    this.error = (accountError || entriesError)?.msg || '';
    this.account = account || null;
    this.entries = entries?.entries || [];
    this.actors = entries?.actors || {};
    this.counterparties = entries?.counterparties || {};
    this.entryTotal = entries?.total || 0;
  };

  page = delta => {
    this.offset = Math.max(0, this.offset + delta * PAGE);
    this.load();
  };

  /*
    Actions

    Every submission carries an idempotency key made when the form opens, so a double click or a
    retry after a timeout applies once. A new form gets a new key.
  */

  openAction = action => {
    this.action = this.action === action ? '' : action;
    this.target = null;
    this.form = {};
    this.#key = newKey();
    this.error = '';
    this.notice = '';
  };

  openTarget = target => {
    this.target = target;
    this.action = '';
    this.form = {};
    this.#key = newKey();
    this.error = '';
    this.notice = '';
  };

  cancel = () => {
    this.action = '';
    this.target = null;
  };

  set = (field, value) => {
    this.form = { ...this.form, [field]: value };
  };

  amount = () => {
    const value = String(this.form.amount ?? '').trim();
    return value === '' ? undefined : Number(value);
  };

  submit = async event => {
    event.preventDefault();
    this.busy = true;
    this.error = '';

    const note = this.form.note || '';
    const idempotencyKey = this.#key;
    let result;

    if(this.action === 'grant'){
      result = await grantCredits(this.userId, {
        amount: this.amount(),
        note,
        idempotencyKey,
      });
    } else if(this.action === 'remove'){
      result = await removeCredits(this.userId, { amount: this.amount(), note, idempotencyKey });
    } else if(this.action === 'forgive'){
      result = await forgiveDebt(this.userId, { amount: this.amount(), note, idempotencyKey });
    } else if(this.target?.kind === 'lot'){
      result = await clawBackLot(this.target.id, { amount: this.amount(), note, idempotencyKey });
    } else if(this.target?.kind === 'spend'){
      result = await reverseOperation(this.target.id, { note });
    }

    this.busy = false;
    const [error, data] = result || [{ msg: 'Nothing to do' }];
    if(error){
      this.error = error.msg;
      return;
    }

    this.notice = data?.duplicate ? 'That was already done — nothing changed.' : 'Done.';
    this.action = '';
    this.target = null;
    await this.load();
  };

  /*
    Rendering
  */

  #renderBalance(){
    const { user, balance, audit } = this.account;

    return html`
      <h2 class="mb0">${user.name || 'Unknown user'}</h2>
      <p class="tc-muted">${user.email || ''} · <span class="ff-mono">${user.id}</span></p>

      <div class="d-f tiles">
        <div class="card tile">
          <span class="tc-muted">Balance</span>
          <span class="value ${balance.total < 0 ? 'tc-danger' : ''}">${formatCredits(balance.total)}</span>
          <span class="tc-muted">${Object.entries(balance.byKind || {}).map(([kind, amount]) => `${formatCredits(amount)} ${kindLabel(kind).toLowerCase()}`).join(' · ') || 'No credits'}</span>
        </div>
        ${balance.owed ? html`
          <div class="card tile">
            <span class="tc-muted">Owes</span>
            <span class="value tc-danger">${formatCredits(balance.owed)}</span>
            <span class="tc-muted">A refund took back more than they held. They cannot spend until it is covered.</span>
          </div>
        ` : nothing}
      </div>

      ${audit.ok ? html`
        <p class="tc-success"><k-icon name="check_circle"></k-icon> The ledger proves this balance: every lot matches its ${audit.entries} entries.</p>
      ` : html`
        <div class="card tc-danger">
          <strong>The ledger does not add up.</strong>
          <ul class="mb0">${audit.problems.map(problem => html`<li>${problem}</li>`)}</ul>
        </div>
      `}
    `;
  }

  #renderActions(){
    const available = Object.entries(ACTIONS).filter(([name, action]) =>
      this.allowed.has(action.permission) && (name !== 'forgive' || this.account.balance.owed));
    if(!available.length) return nothing;

    return html`
      <div class="d-f actions mb">
        ${available.map(([name, action]) => html`
          <button class=${this.action === name ? 'primary' : ''} @click=${() => this.openAction(name)}>${action.label}</button>
        `)}
      </div>
    `;
  }

  #renderForm(){
    const title = this.action ? ACTIONS[this.action].label
      : this.target?.kind === 'lot' ? `Claw back ${this.target.label}`
        : this.target?.kind === 'spend' ? `Reverse a spend of ${formatCredits(this.target.amount)} credits`
          : '';
    if(!title) return nothing;

    const amountLabel = this.action === 'forgive' ? 'Credits to write off (blank for all of it)'
      : this.target?.kind === 'lot' ? 'Credits to take back (blank for all that is left of the grant)'
        : 'Credits';
    const showAmount = this.target?.kind !== 'spend';

    return html`
      <form class="card" @submit=${this.submit}>
        <p><strong>${title}</strong></p>
        ${this.target?.kind === 'lot' ? html`
          <p class="tc-muted">Takes the credits back without moving any money — for a chargeback the site lost, say. Credits come from this grant first, then their other credits; whatever they do not hold is recorded as owed and blocks spending until it is covered.</p>
        ` : nothing}
        ${this.target?.kind === 'spend' ? html`
          <p class="tc-muted">The credits go back to the lots they came from.</p>
        ` : nothing}

        <div class="row -mx">
          ${showAmount ? html`
            <label class="span-4 m-span-12 px">
              <span class="d-b">${amountLabel}</span>
              <input type="number" min="1" step="1" ?required=${this.action === 'grant' || this.action === 'remove'} .value=${this.form.amount ?? ''} @input=${event => this.set('amount', event.target.value)} />
            </label>
          ` : nothing}
          <label class="span-8 m-span-12 px">
            <span class="d-b">Why (required — this is what the ledger will say)</span>
            <input type="text" required maxlength="500" .value=${this.form.note || ''} @input=${event => this.set('note', event.target.value)} />
          </label>
        </div>

        ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
        <div class="d-f actions mb">
          <button class="primary" type="submit" ?disabled=${this.busy}>
            ${this.busy ? 'Working…' : this.action ? ACTIONS[this.action].button : this.target?.kind === 'lot' ? 'Claw back' : 'Reverse'}
          </button>
          <button type="button" @click=${this.cancel}>Cancel</button>
        </div>
      </form>
    `;
  }

  #renderLots(){
    const { lots } = this.account;
    if(!lots.length) return html`<p class="tc-muted">No credits have ever been granted.</p>`;
    const canAdjust = this.allowed.has('credits:adjust');

    return html`
      <div class="table-wrapper mb">
        <table>
          <thead><tr><th>Granted</th><th>Kind</th><th class="ta-right">Amount</th><th class="ta-right">Left</th><th>Why</th><th></th></tr></thead>
          <tbody>
            ${lots.map(lot => html`
              <tr>
                <td>${formatDateTime(lot.createdAt)}</td>
                <td>${kindLabel(lot.kind)}</td>
                <td class="ta-right">${formatCredits(lot.amount)}</td>
                <td class="ta-right ${lot.remaining < 0 ? 'tc-danger' : ''}">
                  ${formatCredits(lot.remaining)}
                </td>
                <td>
                  ${lot.reason}${lot.referenceOwner ? html` <span class="tc-muted">· ${lot.referenceOwner} ${lot.referenceId}</span>` : nothing}
                  ${lot.note ? html`<span class="d-b tc-muted">${lot.note}</span>` : nothing}
                </td>
                <td>
                  ${canAdjust ? html`<button class="link" @click=${() => this.openTarget({ kind: 'lot', id: lot.id, label: `${formatCredits(lot.amount)} ${kindLabel(lot.kind).toLowerCase()} credits from ${formatDate(lot.createdAt)}` })}>Claw back</button>` : nothing}
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    `;
  }

  #renderEntries(){
    if(!this.entries.length) return html`<p class="tc-muted">No entries.</p>`;
    const canAdjust = this.allowed.has('credits:adjust');
    const shownSpends = new Set();

    return html`
      <div class="table-wrapper">
        <table>
          <thead><tr><th>When</th><th>What</th><th class="ta-right">Credits</th><th>Why</th><th>By</th><th></th></tr></thead>
          <tbody>
            ${this.entries.map(entry => {
              /*
                A spend drawn from several lots is several entries in one operation. The reverse
                button goes on the first of them only — reversing undoes the whole operation.
              */
              const reversible = canAdjust && entry.type === 'spend' && !shownSpends.has(entry.operationId);
              if(entry.type === 'spend') shownSpends.add(entry.operationId);
              const operationAmount = this.entries.filter(other => other.operationId === entry.operationId && other.type === 'spend').reduce((sum, other) => sum - other.amount, 0);
              return html`
                <tr>
                  <td>${formatDateTime(entry.createdAt)}</td>
                  <td>
                    ${entryLabel(entry.type)}${entry.counterpartyId ? html` ${entry.type === 'transfer_out' ? 'to' : 'from'} ${this.counterparties[entry.counterpartyId]?.name || html`<span class="ff-mono">${entry.counterpartyId}</span>`}` : nothing}
                    <span class="tc-muted d-b">${kindLabel(entry.kind)}</span>
                  </td>
                  <td class="ta-right ${entry.amount < 0 ? '' : 'tc-success'}">${signed(entry.amount)}</td>
                  <td>
                    ${entry.reason || ''}${entry.referenceOwner ? html` <span class="tc-muted">· ${entry.referenceOwner} ${entry.referenceId}</span>` : nothing}
                    ${entry.note ? html`<span class="d-b tc-muted">${entry.note}</span>` : nothing}
                    ${entry.reversesOperationId ? html`<span class="d-b tc-muted">reverses ${entry.reversesOperationId}</span>` : nothing}
                  </td>
                  <td class="tc-muted">${!entry.actorId ? 'The site' : this.actors[entry.actorId]?.name || html`<span class="ff-mono">${entry.actorId}</span>`}</td>
                  <td>${reversible ? html`<button class="link" @click=${() => this.openTarget({ kind: 'spend', id: entry.operationId, amount: operationAmount })}>Reverse</button>` : nothing}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
      ${this.entryTotal > PAGE ? html`
        <div class="d-f pager">
          <button ?disabled=${this.offset === 0} @click=${() => this.page(-1)}>Newer</button>
          <span class="tc-muted">${this.offset + 1}–${Math.min(this.offset + PAGE, this.entryTotal)} of ${this.entryTotal}</span>
          <button ?disabled=${this.offset + PAGE >= this.entryTotal} @click=${() => this.page(1)}>Older</button>
        </div>
      ` : nothing}
    `;
  }

  render(){
    if(!this.account) return this.error ? html`<p class="tc-danger">${this.error}</p>` : html`<k-spinner></k-spinner>`;

    return html`
      ${this.#renderBalance()}
      ${this.notice ? html`<p class="tc-success" role="status">${this.notice}</p>` : nothing}
      ${this.#renderActions()}
      ${this.#renderForm()}
      ${!this.action && !this.target && this.error ? html`<p class="tc-danger">${this.error}</p>` : nothing}
      <h3>What they were granted</h3>
      ${this.#renderLots()}
      <h3>Every change</h3>
      ${this.#renderEntries()}
    `;
  }

  static styles = css`
    :host { display: block; }
    .tiles, .actions, .pager { gap: var(--spacer); align-items: center; }
    .tile { display: flex; flex-direction: column; min-width: 12rem; }
    .tile .value { font-size: 1.6rem; line-height: 1.2; font-weight: 600; }
  `;
}

customElements.define('k-cred-account', Account);
