import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/admin/extension/kempo-credits/components/Account.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { listAccounts } from '/credits/sdk.js';
import { formatCredits } from '/credits/utils/format.js';

/*
  Giving one person promo credits: find them, then the grant form, open, on their ledger — so whoever
  is giving can see what that person already has before deciding how much more.

  Bought credits are never granted here. They only come from a purchase.
*/
export default class Grant extends ShadowComponent {
  static properties = {
    search: { type: String, state: true },
    results: { type: Array, state: true },
    userId: { type: String, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  #typing = null;

  constructor(){
    super();
    this.search = '';
    this.results = [];
    this.userId = '';
    this.loading = false;
    this.error = '';
  }

  /*
    Data
  */

  find = async () => {
    if(!this.search.trim()){
      this.results = [];
      return;
    }
    this.loading = true;
    const [error, data] = await listAccounts({ search: this.search.trim(), limit: 10 });
    this.loading = false;
    this.error = error ? error.msg : '';
    this.results = data?.accounts || [];
  };

  typed = event => {
    this.search = event.target.value;
    clearTimeout(this.#typing);
    this.#typing = setTimeout(this.find, 300);
  };

  /*
    Rendering
  */

  render(){
    if(this.userId){
      return html`
        <button class="link mb" @click=${() => { this.userId = ''; }}><k-icon name="arrow" direction="left"></k-icon> Someone else</button>
        <k-cred-account user-id=${this.userId} open="grant"></k-cred-account>
      `;
    }

    return html`
      <p class="tc-muted">
        Promo credits are a gift: they are not revenue, they can be set to expire, and they are spent before
        bought credits that expire at the same time. Every grant needs a reason, which the user's ledger keeps.
      </p>
      <div class="d-f controls">
        <input type="search" placeholder="Find a user by name, email or id" .value=${this.search} @input=${this.typed} />
        ${this.loading ? html`<k-spinner size="sm"></k-spinner>` : nothing}
      </div>
      ${this.error ? html`<p class="tc-danger">${this.error}</p>` : nothing}
      ${this.search && !this.loading && !this.results.length ? html`<p class="tc-muted">Nobody matches.</p>` : nothing}
      ${this.results.length ? html`
        <div class="table-wrapper">
          <table>
            <thead><tr><th>User</th><th class="ta-right">Balance</th><th></th></tr></thead>
            <tbody>
              ${this.results.map(account => html`
                <tr>
                  <td>${account.name || account.userId}<span class="tc-muted d-b">${account.email || ''}</span></td>
                  <td class="ta-right">${formatCredits(account.total)}</td>
                  <td><button class="primary" @click=${() => { this.userId = account.userId; }}>Give credits</button></td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      ` : nothing}
    `;
  }

  static styles = css`
    :host { display: block; }
    .controls { gap: var(--spacer); align-items: center; margin-bottom: var(--spacer); }
    .controls input { margin: 0; max-width: 24rem; }
  `;
}

customElements.define('k-cred-grant', Grant);
