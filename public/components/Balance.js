import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getMyBalance } from '/credits/sdk.js';
import { formatCredits, kindLabel } from '/credits/utils/format.js';

/*
  The signed-in user's balance, served at /credits/components/Balance.js.

  ```html
  <script type="module" src="/credits/components/Balance.js"></script>
  <k-cred-balance></k-cred-balance>          <!-- the full card -->
  <k-cred-balance compact></k-cred-balance>  <!-- just the number, for a header -->
  ```

  Call `refresh()` after anything that changes it — a spend your page just made, credits sent.
*/
export default class Balance extends ShadowComponent {
  static properties = {
    compact: { type: Boolean, reflect: true },
    balance: { type: Object, state: true },
    signedOut: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.compact = false;
    this.balance = null;
    this.signedOut = false;
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
    const [error, data] = await getMyBalance();
    this.signedOut = error?.code === 401;
    this.error = error && !this.signedOut ? error.msg : '';
    this.balance = data?.balance || null;
  };

  /*
    Rendering
  */

  render(){
    if(this.signedOut) return this.compact ? nothing : html`<p class="tc-muted m0">Sign in to see your credits.</p>`;
    if(this.error) return html`<span class="tc-danger">${this.error}</span>`;
    if(!this.balance) return html`<span class="tc-muted">…</span>`;

    const { total, owed, byKind } = this.balance;
    const kinds = Object.entries(byKind || {});

    if(this.compact){
      return html`<span title="Your credits"><k-icon src="/credits/icons/credits.svg"></k-icon> ${formatCredits(total)}</span>`;
    }

    return html`
      <div class="card">
        <div class="tc-muted">Your credits</div>
        <div class="value ${total < 0 ? 'tc-danger' : ''}">${formatCredits(total)}</div>
        ${owed ? html`
          <p class="tc-danger">
            You owe ${formatCredits(owed)} credits after a refund. Credits you get next go to that first,
            and you cannot spend until it is covered.
          </p>
        ` : kinds.length > 1 ? html`
          <p class="tc-muted mb">${kinds.map(([kind, amount]) => `${formatCredits(amount)} ${kindLabel(kind).toLowerCase()}`).join(' · ')}</p>
        ` : nothing}
      </div>
    `;
  }

  static styles = css`
    :host { display: block; }
    :host([compact]) { display: inline; }
    .value { font-size: 2rem; font-weight: 600; line-height: 1.2; }
  `;
}

customElements.define('k-cred-balance', Balance);
