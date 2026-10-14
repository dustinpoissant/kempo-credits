import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { listMyEntries } from '/credits/sdk.js';
import { entryLabel, formatDateTime, signed } from '/credits/utils/format.js';

/*
  The signed-in user's own ledger, served at /credits/components/History.js — every way their
  balance has changed, newest first, so "where did my credits go" answers itself.

  ```html
  <k-cred-history></k-cred-history>
  ```
*/

const PAGE = 20;

const REASONS = {
  purchase: 'Bought',
  claim: 'Claimed from a link',
  promo: 'Given by the site',
  refund: 'Purchase refunded',
  expired: 'Expired',
  adjustment: 'Adjusted by the site',
  settlement: 'Applied to what was owed',
};

export default class History extends ShadowComponent {
  static properties = {
    entries: { type: Array, state: true },
    total: { type: Number, state: true },
    offset: { type: Number, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.entries = [];
    this.total = 0;
    this.offset = 0;
    this.loading = true;
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.refresh();
  }

  /*
    Public Methods
  */

  refresh = async () => {
    this.loading = true;
    const [error, data] = await listMyEntries({ limit: PAGE, offset: this.offset });
    this.loading = false;
    this.error = error ? (error.code === 401 ? 'Sign in to see your credit history.' : error.msg) : '';
    this.entries = data?.entries || [];
    this.total = data?.total || 0;
  };

  page = delta => {
    this.offset = Math.max(0, this.offset + delta * PAGE);
    this.refresh();
  };

  /*
    Rendering
  */

  render(){
    if(this.error) return html`<p class="tc-muted">${this.error}</p>`;
    if(this.loading && !this.entries.length) return html`<k-spinner></k-spinner>`;
    if(!this.entries.length) return html`<p class="tc-muted">Nothing yet.</p>`;

    return html`
      <div class="table-wrapper">
        <table>
          <thead><tr><th>When</th><th>What</th><th class="ta-right">Credits</th></tr></thead>
          <tbody>
            ${this.entries.map(entry => html`
              <tr>
                <td class="tc-muted">${formatDateTime(entry.createdAt)}</td>
                <td>
                  ${entryLabel(entry.type)}
                  <span class="tc-muted d-b">
                    ${REASONS[entry.reason] || entry.reason || nothing}${entry.kind === 'promo' ? ' · free credits' : nothing}
                  </span>
                </td>
                <td class="ta-right ${entry.amount < 0 ? '' : 'tc-success'}">${signed(entry.amount)}</td>
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

  static styles = css`
    :host { display: block; }
    .pager { align-items: center; gap: var(--spacer_h); }
  `;
}

customElements.define('k-cred-history', History);
