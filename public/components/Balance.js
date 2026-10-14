import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getMyBalance } from '/credits/sdk.js';
import { formatCredits, formatDate } from '/credits/utils/format.js';

/*
  The signed-in user's balance, served at /credits/components/Balance.js.

  ```html
  <script type="module" src="/credits/components/Balance.js"></script>
  <k-cred-balance></k-cred-balance>          <!-- the full card -->
  <k-cred-balance compact></k-cred-balance>  <!-- just the number, for a header -->
  ```

  Call `refresh()` after anything that changes it — a purchase, a spend your page just made.
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

    const { total, paid, promo, owed, expiringSoon, nextExpiresAt } = this.balance;

    if(this.compact){
      return html`<span title="Your credits"><k-icon name="toll"></k-icon> ${formatCredits(total)}</span>`;
    }

    return html`
      <div class="card">
        <div class="tc-muted">Your credits</div>
        <div class="value ${total < 0 ? 'tc-danger' : ''}">${formatCredits(total)}</div>
        ${owed ? html`
          <p class="tc-danger">
            You owe ${formatCredits(owed)} credits from a refunded purchase. Credits you get next go to that first,
            and you cannot spend until it is covered.
          </p>
        ` : html`
          <p class="tc-muted mb">
            ${formatCredits(paid)} bought · ${formatCredits(promo)} free
            ${expiringSoon ? html`· <span class="tc-warning">${formatCredits(expiringSoon)} expire soon</span>` : nothing}
            ${nextExpiresAt && !expiringSoon ? html`· next expiry ${formatDate(nextExpiresAt)}` : nothing}
          </p>
        `}
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
