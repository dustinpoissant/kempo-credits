import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getSettings, saveSettings } from '/credits/sdk.js';

/*
  The credits settings, grouped by what they decide.

  These are ordinary kempo settings and also appear on /admin/settings; this screen adds the
  grouping, the warnings, and validation that refuses a typo instead of quietly using the default.
  Only changed values are sent.
*/

const GROUPS = [
  { title: 'At checkout', names: ['refund_policy', 'tax_class'] },
  { title: 'Balances', names: ['low_balance_threshold', 'expiring_soon_days', 'paid_credits_expire', 'paid_credits_expiry_days'] },
  {
    title: 'Card-testing protection',
    note: 'Limits on how often purchases can be attempted, counted over the last hour. Attempts over a limit are refused before they reach the payment processor and appear under Purchases → Blocked attempts.',
    names: ['purchase_limit_per_user', 'purchase_limit_per_ip', 'purchase_limit_global', 'failed_payment_limit', 'failed_payment_cooldown_minutes', 'trust_proxy'],
  },
];

const LABELS = {
  refund_policy: 'Refund policy',
  tax_class: 'Tax class',
  low_balance_threshold: 'Low-balance threshold',
  expiring_soon_days: 'Expiring soon (days)',
  paid_credits_expire: 'Bought credits expire',
  paid_credits_expiry_days: 'Bought credits expire after (days)',
  purchase_limit_per_user: 'Attempts per account',
  purchase_limit_per_ip: 'Attempts per IP address',
  purchase_limit_global: 'Attempts for the whole site',
  failed_payment_limit: 'Declines before a cool-down',
  failed_payment_cooldown_minutes: 'Cool-down (minutes)',
  trust_proxy: 'Behind a proxy',
};

export default class Settings extends ShadowComponent {
  static properties = {
    settings: { type: Array, state: true },
    tax: { type: Boolean, state: true },
    edits: { type: Object, state: true },
    busy: { type: Boolean, state: true },
    error: { type: String, state: true },
    notice: { type: String, state: true },
  };

  constructor(){
    super();
    this.settings = [];
    this.tax = false;
    this.edits = {};
    this.busy = false;
    this.error = '';
    this.notice = '';
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
    const [error, data] = await getSettings();
    this.error = error ? error.msg : '';
    this.settings = data?.settings || [];
    this.tax = !!data?.tax;
    this.edits = {};
  };

  value = name => name in this.edits ? this.edits[name] : this.settings.find(setting => setting.name === name)?.value;

  set = (name, value) => {
    this.edits = { ...this.edits, [name]: value };
    this.notice = '';
  };

  save = async event => {
    event.preventDefault();
    if(!Object.keys(this.edits).length){
      this.notice = 'Nothing has changed.';
      return;
    }
    this.busy = true;
    const [error] = await saveSettings(this.edits);
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    await this.load();
    this.notice = 'Saved.';
  };

  /*
    Rendering
  */

  #renderField(setting){
    const { name, type, description } = setting;
    const value = this.value(name);

    if(type === 'boolean'){
      return html`
        <div class="mb">
          <label class="checkbox"><input type="checkbox" .checked=${!!value} @change=${event => this.set(name, event.target.checked)} /> ${LABELS[name]}</label>
          <p class="tc-muted mb0">${description}</p>
          ${name === 'paid_credits_expire' && value ? html`
            <div class="card tc-danger mt">
              <strong>Take advice before turning this on.</strong>
              <p class="mb0">
                Bought credits are a prepaid balance. Many places restrict letting one expire — gift-card and consumer-protection
                rules, and unclaimed-property law that can require the unspent value to be reported or handed over. It applies to
                credits bought from now on; credits already bought keep never expiring.
              </p>
            </div>
          ` : nothing}
        </div>
      `;
    }

    if(name === 'refund_policy'){
      return html`
        <label class="mb"><span class="d-b">${LABELS[name]}</span>
          <textarea rows="3" maxlength="2000" .value=${value ?? ''} @input=${event => this.set(name, event.target.value)}></textarea>
          <span class="tc-muted d-b">${description}</span>
        </label>
      `;
    }

    return html`
      <label class="mb"><span class="d-b">${LABELS[name]}</span>
        <input
          type=${type === 'number' ? 'number' : 'text'}
          min=${type === 'number' ? 0 : nothing}
          step=${type === 'number' ? 1 : nothing}
          .value=${String(value ?? '')}
          @input=${event => this.set(name, type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
        />
        <span class="tc-muted d-b">${description}</span>
      </label>
    `;
  }

  render(){
    if(!this.settings.length) return this.error ? html`<p class="tc-danger">${this.error}</p>` : html`<k-spinner></k-spinner>`;

    return html`
      <form @submit=${this.save}>
        <div class="row">
          <div class="span-8 t-span-12 m-span-12">
            ${GROUPS.map(group => html`
              <h3>${group.title}</h3>
              ${group.note ? html`<p class="tc-muted">${group.note}</p>` : nothing}
              ${group.title === 'At checkout' ? html`
                <p class="${this.tax ? 'tc-success' : 'tc-muted'}">
                  ${this.tax
                    ? 'kempo-tax is enabled, so buyers give a billing address and tax is added to (or included in) each pack’s price.'
                    : 'kempo-tax is not enabled, so packs are charged at their price with no tax. The tax class below is used if it is.'}
                </p>
              ` : nothing}
              ${group.names.map(name => this.settings.find(setting => setting.name === name)).filter(Boolean).map(setting => this.#renderField(setting))}
            `)}
            ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
            ${this.notice ? html`<p class="tc-success" role="status">${this.notice}</p>` : nothing}
            <button class="primary" type="submit" ?disabled=${this.busy}>${this.busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </form>
    `;
  }

  static styles = css`
    :host { display: block; }
  `;
}

customElements.define('k-cred-settings', Settings);
