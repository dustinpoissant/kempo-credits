import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { createClaim, listClaims, setClaimEnabled } from '/credits/sdk.js';
import { formatCredits, formatDate } from '/credits/utils/format.js';

/*
  Claim links: a link that gives promo credits to whoever opens it and signs in — a launch, a
  newsletter, an apology.

  **The link is shown once**, straight after it is made. Only a hash of it is kept, so a database
  backup that leaks is not a way to mint credits — and so this screen cannot show it again. Copy it
  then.

  Each person can claim a link once. A limit caps the total, and holds however many people claim at
  the same moment. The link itself can stop working after a number of days; the credits it has given
  never expire.
*/

const blank = () => ({ name: '', amount: '', linkDays: '', max: '' });

export default class Claims extends ShadowComponent {
  static properties = {
    claims: { type: Array, state: true },
    form: { type: Object, state: true },
    made: { type: Object, state: true },
    copied: { type: Boolean, state: true },
    busy: { type: Boolean, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.claims = [];
    this.form = null;
    this.made = null;
    this.copied = false;
    this.busy = false;
    this.loading = true;
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.load();
  }

  /*
    Data
  */

  load = async () => {
    this.loading = true;
    const [error, data] = await listClaims();
    this.loading = false;
    this.error = error ? error.msg : '';
    this.claims = data?.claims || [];
  };

  /*
    Actions
  */

  set = (field, value) => {
    this.form = { ...this.form, [field]: value };
  };

  create = async event => {
    event.preventDefault();
    const number = value => String(value).trim() === '' ? undefined : Number(value);

    this.busy = true;
    const [error, result] = await createClaim({
      name: this.form.name || undefined,
      amount: number(this.form.amount),
      expiresInDays: number(this.form.linkDays),
      maxRedemptions: number(this.form.max),
    });
    this.busy = false;

    if(error){
      this.error = error.msg;
      return;
    }

    this.made = { ...result, url: `${location.origin}/credits/claim?token=${result.token}` };
    this.copied = false;
    this.form = null;
    this.error = '';
    this.load();
  };

  copy = async () => {
    try {
      await navigator.clipboard.writeText(this.made.url);
      this.copied = true;
    } catch {
      this.shadowRoot.querySelector('#made-url')?.select();
    }
  };

  toggle = async claim => {
    const [error] = await setClaimEnabled(claim.id, !claim.enabled);
    this.error = error ? error.msg : '';
    this.load();
  };

  /*
    Rendering
  */

  #renderMade(){
    return html`
      <div class="card">
        <p class="tc-success"><strong><k-icon name="check_circle"></k-icon> Link made.</strong> Copy it now — it cannot be shown again.</p>
        <div class="d-f actions mb">
          <input id="made-url" class="flex" type="text" readonly .value=${this.made.url} @focus=${event => event.target.select()} />
          <button class="primary" @click=${this.copy}><k-icon name="content_copy"></k-icon> ${this.copied ? 'Copied' : 'Copy'}</button>
        </div>
        <button class="link" @click=${() => { this.made = null; }}>Done</button>
      </div>
    `;
  }

  #renderForm(){
    const form = this.form;
    return html`
      <form class="card" @submit=${this.create}>
        <p><strong>New claim link</strong></p>
        <div class="row -mx">
          <label class="span-6 m-span-12 px"><span class="d-b">Name <span class="tc-muted">optional, shown to whoever opens it</span></span>
            <input type="text" maxlength="100" placeholder="Launch week" .value=${form.name} @input=${event => this.set('name', event.target.value)} />
          </label>
          <label class="span-3 m-span-6 px"><span class="d-b">Credits each</span>
            <input type="number" required min="1" step="1" .value=${form.amount} @input=${event => this.set('amount', event.target.value)} />
          </label>
          <label class="span-3 m-span-6 px"><span class="d-b">Limit <span class="tc-muted">blank for none</span></span>
            <input type="number" min="1" step="1" .value=${form.max} @input=${event => this.set('max', event.target.value)} />
          </label>
          <label class="span-4 m-span-12 px"><span class="d-b">The link stops working after <span class="tc-muted">days, blank for never</span></span>
            <input type="number" min="1" step="1" .value=${form.linkDays} @input=${event => this.set('linkDays', event.target.value)} />
          </label>
        </div>
        ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
        <div class="d-f actions mb">
          <button class="primary" type="submit" ?disabled=${this.busy}>${this.busy ? 'Making…' : 'Make the link'}</button>
          <button type="button" @click=${() => { this.form = null; }}>Cancel</button>
        </div>
      </form>
    `;
  }

  #renderList(){
    if(this.loading && !this.claims.length) return html`<k-spinner></k-spinner>`;
    if(!this.claims.length) return html`<p class="tc-muted">No claim links yet.</p>`;

    return html`
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Link</th><th class="ta-right">Credits</th><th>Claimed</th><th>Link stops working</th><th></th></tr></thead>
          <tbody>
            ${this.claims.map(claim => {
              const expired = claim.expiresAt && new Date(claim.expiresAt) <= new Date();
              const usedUp = claim.maxRedemptions && claim.redemptions >= claim.maxRedemptions;
              return html`
                <tr>
                  <td>
                    ${claim.name || html`<span class="tc-muted">Unnamed</span>`}
                    <span class="tc-muted d-b">…${claim.tokenHint} · ${formatDate(claim.createdAt)}</span>
                  </td>
                  <td class="ta-right">${formatCredits(claim.amount)}</td>
                  <td>${claim.redemptions}${claim.maxRedemptions ? ` of ${claim.maxRedemptions}` : ''}</td>
                  <td>${claim.expiresAt ? formatDate(claim.expiresAt) : 'Never'}</td>
                  <td>
                    ${!claim.enabled ? html`<span class="tc-muted mr">Off</span>` : expired ? html`<span class="tc-muted mr">Expired</span>` : usedUp ? html`<span class="tc-muted mr">Used up</span>` : html`<span class="tc-success mr">Live</span>`}
                    <button class="link" @click=${() => this.toggle(claim)}>${claim.enabled ? 'Turn off' : 'Turn on'}</button>
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  render(){
    return html`
      ${this.made ? this.#renderMade() : nothing}
      ${this.form ? this.#renderForm() : html`<button class="primary mb" @click=${() => { this.form = blank(); this.error = ''; }}><k-icon name="add"></k-icon> New claim link</button>`}
      ${!this.form && this.error ? html`<p class="tc-danger">${this.error}</p>` : nothing}
      ${this.#renderList()}
    `;
  }

  static styles = css`
    :host { display: block; }
    .actions { gap: var(--spacer); align-items: center; }
    .actions input { margin: 0; }
  `;
}

customElements.define('k-cred-claims', Claims);
