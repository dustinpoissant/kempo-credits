import LightComponent from '/kempo-ui/components/LightComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import '/payments/components/PaymentForm.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { checkPurchase, getCheckout, getMyBalance, listPacks, startPurchase } from '/credits/sdk.js';
import { formatAmount, formatCredits } from '/credits/utils/format.js';

/*
  Buying a pack, served at /credits/components/BuyCredits.js.

  ```html
  <script type="module" src="/credits/components/BuyCredits.js"></script>
  <k-cred-buy></k-cred-buy>
  ```

  Choose a pack (and give a billing address when the site charges tax), see exactly what will be
  charged and the refund policy, pay, and wait for the processor to confirm. Fires `credits-purchased`
  once the credits have actually been added — after the server has heard from the processor, not
  when the card form says it went through.

  **Light DOM, and it has to be.** This hosts kempo-payments' `<k-pay-form>`, and Stripe's card
  fields do not mount inside a shadow root: they reserve the space and render nothing, with no error
  anywhere. So nothing above this element may be a shadow root either. Its look therefore comes from
  kempo-css utility classes only.
*/

const COUNTRIES = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'SE', 'NO', 'DK', 'FI', 'AT', 'CH', 'PL', 'PT', 'JP', 'SG', 'IN', 'BR', 'MX'];

const POLL_MS = 2000;
const GIVE_UP_MS = 60000;

export default class BuyCredits extends LightComponent {
  static properties = {
    step: { type: String, state: true },
    packs: { type: Array, state: true },
    checkout: { type: Object, state: true },
    packId: { type: String, state: true },
    address: { type: Object, state: true },
    purchase: { type: Object, state: true },
    clientSecret: { type: String, state: true },
    shown: { type: Object, state: true },
    busy: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  #poll = null;

  constructor(){
    super();
    this.step = 'loading';
    this.packs = [];
    this.checkout = null;
    this.packId = '';
    this.address = { country: 'US', state: '', postalCode: '', city: '', line1: '' };
    this.purchase = null;
    this.clientSecret = '';
    this.shown = null;
    this.busy = false;
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.load();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    clearTimeout(this.#poll);
  }

  load = async () => {
    const [[balanceError], [packsError, packs], [checkoutError, checkout]] = await Promise.all([getMyBalance(), listPacks(), getCheckout()]);

    if(packsError || checkoutError){
      this.error = (packsError || checkoutError).msg;
      this.step = 'broken';
      return;
    }

    this.packs = packs.packs;
    this.checkout = checkout;
    this.packId ||= this.packs[0]?.id || '';
    this.step = balanceError?.code === 401 ? 'signed-out' : 'choose';
  };

  /*
    Actions
  */

  get pack(){
    return this.packs.find(pack => pack.id === this.packId) || null;
  }

  setAddress = (field, value) => {
    this.address = { ...this.address, [field]: field === 'country' ? value.toUpperCase().slice(0, 2) : value };
  };

  /*
    Asks the server to price the pack and open the payment. The server decides the amount; this
    sends only which pack, and where the buyer is for the tax.
  */
  start = async event => {
    event?.preventDefault();
    if(!this.pack) return;

    this.busy = true;
    this.error = '';
    const [error, result] = await startPurchase({
      packId: this.pack.id,
      address: this.checkout.needsAddress ? this.address : undefined,
    });
    this.busy = false;

    if(error){
      this.error = error.msg;
      return;
    }

    this.purchase = result.purchase;
    this.clientSecret = result.clientSecret;
    this.shown = result.shown;
    this.step = 'pay';
  };

  /*
    The card form saying the payment went through is the cue to start asking the server — never
    proof of anything by itself. The server asks the processor, and only grants when it says so.
  */
  confirm = () => {
    this.step = 'confirming';
    const started = Date.now();

    const ask = async () => {
      const [error, data] = await checkPurchase(this.purchase.id);
      if(!error) this.purchase = data.purchase;

      if(this.purchase.status === 'paid'){
        this.step = 'done';
        this.dispatchEvent(new CustomEvent('credits-purchased', { detail: { purchase: this.purchase }, bubbles: true, composed: true }));
        return;
      }

      if(Date.now() - started > GIVE_UP_MS){
        this.step = 'slow';
        return;
      }

      this.#poll = setTimeout(ask, POLL_MS);
    };

    ask();
  };

  again = () => {
    clearTimeout(this.#poll);
    this.purchase = null;
    this.clientSecret = '';
    this.shown = null;
    this.error = '';
    this.step = 'choose';
  };

  /*
    Rendering
  */

  #renderPacks(){
    if(!this.packs.length) return html`<p class="tc-muted">There is nothing for sale right now.</p>`;

    return html`
      <div class="row -mx">
        ${this.packs.map(pack => html`
          <div class="span-4 t-span-6 m-span-12 px">
            <label class="card d-b ${pack.id === this.packId ? 'b bg-alt' : ''}">
              <input
                type="radio"
                name="k-cred-pack"
                .checked=${pack.id === this.packId}
                @change=${() => { this.packId = pack.id; }}
              />
              <strong class="h4">${formatCredits(pack.credits)} credits</strong>
              <span class="d-b">${formatAmount(pack.price, pack.currency)}${this.checkout?.taxed ? html` <span class="tc-muted">+ tax where it applies</span>` : nothing}</span>
              <span class="d-b tc-muted">${pack.name}${pack.description ? html` — ${pack.description}` : nothing}</span>
            </label>
          </div>
        `)}
      </div>
    `;
  }

  #renderAddress(){
    if(!this.checkout?.needsAddress) return nothing;

    const field = (name, label, attrs = {}) => html`
      <label class="mb">
        <span class="d-b">${label}</span>
        <input
          type="text"
          autocomplete=${attrs.autocomplete || 'off'}
          list=${attrs.list || nothing}
          maxlength=${attrs.maxlength || 200}
          ?required=${attrs.required}
          .value=${this.address[name] || ''}
          @input=${event => this.setAddress(name, event.target.value)}
        />
      </label>
    `;

    return html`
      <fieldset class="mb">
        <legend>Billing address</legend>
        <p class="tc-muted">Tax depends on where you are, so it is worked out from this before you pay.</p>
        <datalist id="k-cred-countries">${COUNTRIES.map(code => html`<option value=${code}></option>`)}</datalist>
        <div class="row -mx">
          <div class="span-4 m-span-12 px">${field('country', 'Country (two letters)', { autocomplete: 'country', list: 'k-cred-countries', maxlength: 2, required: true })}</div>
          <div class="span-4 m-span-6 px">${field('state', 'State or region', { autocomplete: 'address-level1' })}</div>
          <div class="span-4 m-span-6 px">${field('postalCode', 'Postal code', { autocomplete: 'postal-code' })}</div>
          <div class="span-6 m-span-12 px">${field('city', 'City', { autocomplete: 'address-level2' })}</div>
          <div class="span-6 m-span-12 px">${field('line1', 'Street address', { autocomplete: 'address-line1' })}</div>
        </div>
      </fieldset>
    `;
  }

  #renderSummary(){
    const { pack, currency, subtotal, tax, total, includesTax, taxed, refundPolicy } = this.shown;

    const line = (label, amount, strong = false) => html`
      <div class="d-f mbq">
        <span class="flex">${strong ? html`<strong>${label}</strong>` : label}</span>
        <span>${strong ? html`<strong>${formatAmount(amount, currency)}</strong>` : formatAmount(amount, currency)}</span>
      </div>
    `;

    return html`
      <div class="card">
        <p><strong>${formatCredits(pack.credits)} credits</strong> — ${pack.name}</p>
        ${taxed && !includesTax ? html`${line('Price', subtotal)}${line('Tax', tax)}` : nothing}
        ${line('Total', total, true)}
        ${taxed && includesTax ? html`<p class="tc-muted mb0">Includes ${formatAmount(tax, currency)} tax.</p>` : nothing}
        ${refundPolicy ? html`<p class="tc-muted mt"><strong>Refunds:</strong> ${refundPolicy}</p>` : html`<div class="mb"></div>`}
      </div>
    `;
  }

  renderLightDom(){
    if(this.step === 'loading') return html`<k-spinner></k-spinner>`;
    if(this.step === 'broken') return html`<p class="tc-danger">${this.error}</p>`;

    if(this.step === 'signed-out'){
      return html`
        ${this.#renderPacks()}
        <p>Sign in to buy credits.</p>
        <a class="btn primary" href="/login?redirect=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>
      `;
    }

    if(this.step === 'choose'){
      return html`
        <form @submit=${this.start}>
          ${this.#renderPacks()}
          ${this.#renderAddress()}
          ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
          <button class="primary" type="submit" ?disabled=${this.busy || !this.pack}>
            ${this.busy ? 'Working out the total…' : 'Continue'}
          </button>
        </form>
      `;
    }

    if(this.step === 'pay'){
      return html`
        <div class="row">
          <div class="span-6 t-span-9 m-span-12">
            ${this.#renderSummary()}
            <div class="card">
              <k-pay-form
                client-secret=${this.clientSecret}
                submit-label="Pay ${formatAmount(this.shown.total, this.shown.currency)}"
                @payment-succeeded=${this.confirm}
                @payment-processing=${this.confirm}
              ></k-pay-form>
            </div>
            <button class="link" @click=${this.again}><k-icon name="arrow" direction="left"></k-icon> Choose a different pack</button>
          </div>
        </div>
      `;
    }

    if(this.step === 'confirming'){
      return html`<p class="tc-muted"><k-spinner></k-spinner> Payment sent. Waiting for the payment processor to confirm it…</p>`;
    }

    if(this.step === 'slow'){
      return html`
        <div class="card">
          <p><strong>Your payment is still being confirmed.</strong></p>
          <p class="tc-muted">
            Some payments take a little longer. Your credits will be added as soon as it is confirmed — there is no
            need to pay again. You can check back here.
          </p>
          <button @click=${this.confirm}>Check again</button>
        </div>
      `;
    }

    return html`
      <div class="card">
        <p class="tc-success"><strong><k-icon name="check_circle"></k-icon> ${formatCredits(this.purchase.credits)} credits added.</strong></p>
        <p class="tc-muted">
          Receipt ${this.purchase.id} · ${formatAmount(this.purchase.total, this.purchase.currency)}
          ${this.purchase.tax ? html` (${formatAmount(this.purchase.tax, this.purchase.currency)} tax)` : nothing}
        </p>
        <button @click=${this.again}>Buy more</button>
      </div>
    `;
  }
}

customElements.define('k-cred-buy', BuyCredits);
