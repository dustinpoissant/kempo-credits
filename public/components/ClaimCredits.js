import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { previewClaim, redeemClaim } from '/credits/sdk.js';
import { formatCredits, formatDate } from '/credits/utils/format.js';

/*
  Redeeming a claim link, served at /credits/components/ClaimCredits.js. The /credits/claim page
  uses it; the token comes from the `token` attribute, or the page's own `?token=`.

  Shows what the link is worth before anybody signs in, so the reason to sign in is on screen.
*/
export default class ClaimCredits extends ShadowComponent {
  static properties = {
    token: { type: String },
    claim: { type: Object, state: true },
    signedIn: { type: Boolean, state: true },
    result: { type: Object, state: true },
    busy: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.token = '';
    this.claim = null;
    this.signedIn = false;
    this.result = null;
    this.busy = false;
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.token ||= new URLSearchParams(location.search).get('token') || '';
    this.load();
  }

  load = async () => {
    if(!this.token){
      this.error = 'This link is missing its code.';
      return;
    }
    const [error, data] = await previewClaim(this.token);
    if(error){
      this.error = error.msg;
      return;
    }
    this.claim = data.claim;
    this.signedIn = data.signedIn;
  };

  /*
    Actions
  */

  redeem = async () => {
    this.busy = true;
    this.error = '';
    const [error, result] = await redeemClaim(this.token);
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.result = result;
    this.dispatchEvent(new CustomEvent('credits-claimed', { detail: result, bubbles: true, composed: true }));
  };

  /*
    Rendering
  */

  render(){
    if(this.error && !this.claim) return html`<p class="tc-danger">${this.error}</p>`;
    if(!this.claim) return html`<k-spinner></k-spinner>`;

    const { name, amount, available, reason, redeemed, lotExpiresAt, lotExpiresInDays, expiresAt } = this.claim;

    if(this.result){
      return html`
        <div class="card">
          <p class="tc-success"><strong><k-icon name="check_circle"></k-icon> ${formatCredits(amount)} credits added.</strong></p>
          <p class="tc-muted">You now have ${formatCredits(this.result.balance.total)} credits.</p>
          <a class="btn" href="/credits/">See your credits</a>
        </div>
      `;
    }

    return html`
      <div class="card">
        ${name ? html`<p class="tc-muted mbq">${name}</p>` : nothing}
        <p class="value">${formatCredits(amount)} free credits</p>
        <p class="tc-muted">
          ${lotExpiresInDays ? `They expire ${lotExpiresInDays} day${lotExpiresInDays === 1 ? '' : 's'} after you claim them.` : nothing}
          ${lotExpiresAt ? `They expire on ${formatDate(lotExpiresAt)}.` : nothing}
          ${!lotExpiresAt && !lotExpiresInDays ? 'They do not expire.' : nothing}
          ${expiresAt && available ? html` Claim by ${formatDate(expiresAt)}.` : nothing}
        </p>

        ${redeemed ? html`<p class="tc-muted">You have already claimed these.</p>` : !available ? html`
          <p class="tc-danger">${reason}</p>
        ` : !this.signedIn ? html`
          <p>Sign in or create an account to claim them.</p>
          <a class="btn primary" href="/login?redirect=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>
        ` : html`
          ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
          <button class="primary" ?disabled=${this.busy} @click=${this.redeem}>${this.busy ? 'Claiming…' : 'Claim them'}</button>
        `}
      </div>
    `;
  }

  static styles = css`
    :host { display: block; }
    .value { font-size: 2rem; font-weight: 600; line-height: 1.2; }
  `;
}

customElements.define('k-cred-claim', ClaimCredits);
