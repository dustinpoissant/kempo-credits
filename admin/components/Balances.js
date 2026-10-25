import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getSummary, listAccounts } from '/credits/sdk.js';
import { formatCredits, formatDateTime } from '/credits/utils/format.js';

/*
  Every user's balance. Each user is a link to their own page (/admin/extension/kempo-credits/account/),
  with the ledger and the forms, so the address changes and the back button works.

  Search finds anybody by name, email or id — including people who have never had a credit, because
  "find this person" is the question that brings somebody here. With no search the list is the users
  who have a ledger, most recently active first. "Owing" narrows to users a refund took more credits
  from than they held: the ones that need a decision.
*/

const PAGE = 25;
const ACCOUNT = '/admin/extension/kempo-credits/account/';

export default class Balances extends ShadowComponent {
  static properties = {
    accounts: { type: Array, state: true },
    total: { type: Number, state: true },
    offset: { type: Number, state: true },
    search: { type: String, state: true },
    owing: { type: Boolean, state: true },
    summary: { type: Object, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  #typing = null;

  constructor(){
    super();
    this.accounts = [];
    this.total = 0;
    this.offset = 0;
    this.search = '';
    this.owing = false;
    this.summary = null;
    this.loading = true;
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
const pane = this.closest('k-tab-content');
    // Loads when its tab is first opened, so a tab nobody opens makes no requests.
    if(!pane || pane.active) this.load();
    else this.closest('k-tabs')?.addEventListener('tabfirstshown', ({ detail }) => {
      if(detail.tab === pane.name) this.load();
    });
  }

  /*
    Data
  */

  load = async () => {
    this.loading = true;
    const [[error, data], [, summary]] = await Promise.all([
      listAccounts({ search: this.search || undefined, owing: this.owing ? 1 : undefined, limit: PAGE, offset: this.offset }),
      getSummary(),
    ]);
    this.loading = false;
    this.error = error ? error.msg : '';
    this.accounts = data?.accounts || [];
    this.total = data?.total || 0;
    this.summary = summary || null;
  };

  typed = event => {
    this.search = event.target.value;
    this.offset = 0;
    clearTimeout(this.#typing);
    this.#typing = setTimeout(this.load, 300);
  };

  toggleOwing = event => {
    this.owing = event.target.checked;
    this.offset = 0;
    this.load();
  };

  page = delta => {
    this.offset = Math.max(0, this.offset + delta * PAGE);
    this.load();
  };

  /* A click anywhere on the row goes to the same address as the link in it. */
  go = userId => {
    location.assign(`${ACCOUNT}?user=${encodeURIComponent(userId)}`);
  };

  /*
    Rendering
  */

  #renderTiles(){
    if(!this.summary) return nothing;
    const { credits } = this.summary;

    return html`
      <div class="d-f tiles">
        <div class="card tile">
          <span class="tc-muted">Credits held</span>
          <span class="value">${formatCredits(credits.total)}</span>
          <span class="tc-muted">By ${credits.holders} user${credits.holders === 1 ? '' : 's'}</span>
        </div>
        ${credits.owing ? html`
          <div class="card tile">
            <span class="tc-muted">Owing after a refund</span>
            <span class="value tc-danger">${formatCredits(credits.owed)}</span>
            <span class="tc-muted">${credits.owing} user${credits.owing === 1 ? '' : 's'} who cannot spend until it is covered</span>
          </div>
        ` : nothing}
      </div>
    `;
  }

  #renderTable(){
    if(this.loading && !this.accounts.length) return html`<k-spinner></k-spinner>`;
    if(!this.accounts.length){
      return html`<p class="tc-muted">${this.search ? 'Nobody matches that search.' : this.owing ? 'Nobody owes anything.' : 'Nobody has any credits yet.'}</p>`;
    }

    return html`
      <div class="table-wrapper">
        <table>
          <thead>
            <tr><th>User</th><th class="ta-right">Balance</th><th>Last change</th></tr>
          </thead>
          <tbody>
            ${this.accounts.map(account => html`
              <tr @click=${() => this.go(account.userId)}>
                <td>
                  ${account.name
                    ? html`<a href="${ACCOUNT}?user=${encodeURIComponent(account.userId)}" @click=${event => event.stopPropagation()}>${account.name}</a>`
                    : html`<a href="${ACCOUNT}?user=${encodeURIComponent(account.userId)}" @click=${event => event.stopPropagation()}><span class="tc-muted">No such user</span></a>`}
                  <span class="tc-muted d-b">${account.email || account.userId}</span>
                </td>
                <td class="ta-right ${account.total < 0 ? 'tc-danger' : ''}">
                  ${formatCredits(account.total)}
                  ${account.owed ? html`<span class="d-b">owes ${formatCredits(account.owed)}</span>` : nothing}
                </td>
                <td class="tc-muted">${account.lastActivity ? formatDateTime(account.lastActivity) : 'Never'}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      ${this.total > PAGE ? html`
        <div class="d-f pager">
          <button ?disabled=${this.offset === 0} @click=${() => this.page(-1)}>Previous</button>
          <span class="tc-muted">${this.offset + 1}–${Math.min(this.offset + PAGE, this.total)} of ${this.total}</span>
          <button ?disabled=${this.offset + PAGE >= this.total} @click=${() => this.page(1)}>Next</button>
        </div>
      ` : nothing}
    `;
  }

  render(){
    return html`
      ${this.#renderTiles()}
      <div class="d-f controls">
        <input type="search" placeholder="Find a user by name, email or id" .value=${this.search} @input=${this.typed} />
        <label class="checkbox"><input type="checkbox" .checked=${this.owing} @change=${this.toggleOwing} /> Only accounts that owe credits</label>
        ${this.loading ? html`<k-spinner size="sm"></k-spinner>` : nothing}
      </div>
      ${this.error ? html`<p class="tc-danger">${this.error}</p>` : nothing}
      ${this.#renderTable()}
    `;
  }

  static styles = css`
    :host { display: block; }
    .tiles, .controls, .pager { gap: var(--spacer); align-items: center; }
    .tiles { margin-bottom: var(--spacer); }
    .tile { display: flex; flex-direction: column; gap: var(--spacer_q); min-width: 13rem; padding-bottom: var(--spacer); }
    .tile .value { font-size: 1.6rem; line-height: 1.2; font-weight: 600; }
    .controls { margin-bottom: var(--spacer); }
    .controls input[type="search"] { margin: 0; max-width: 24rem; }
    .controls label { margin: 0; }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: var(--c_bg__alt); }
  `;
}

customElements.define('k-cred-balances', Balances);
