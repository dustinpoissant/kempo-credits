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
  { title: 'Value', note: 'Products that accept credits as payment use this rate. Products that give credits are not affected.', names: ['credits_per_unit'] },
  { title: 'Balances', note: 'Credits never expire.', names: ['low_balance_threshold'] },
  {
    title: 'Transfers',
    note: 'Users can send their own credits to each other only once the credits:transfer permission is given to a group. Code that calls transferCredits directly is not stopped by that, but is by the setting below.',
    names: ['non_transferable_kinds'],
  },
];

const LABELS = {
  credits_per_unit: 'Credits that equal one whole currency unit',
  low_balance_threshold: 'Low-balance threshold',
  non_transferable_kinds: 'Kinds that cannot be sent',
};

export default class Settings extends ShadowComponent {
  static properties = {
    settings: { type: Array, state: true },
    edits: { type: Object, state: true },
    busy: { type: Boolean, state: true },
    error: { type: String, state: true },
    notice: { type: String, state: true },
  };

  constructor(){
    super();
    this.settings = [];
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
    const [error, data] = await getSettings();
    this.error = error ? error.msg : '';
    this.settings = data?.settings || [];
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
          <label class="checkbox"><input type="checkbox" .checked=${!!value} @change=${event => this.set(name, event.target.checked)} /> ${LABELS[name]}<small class="d-b tc-muted">${description}</small></label>
        </div>
      `;
    }

    return html`
      <label class="d-b mb"><span class="d-b">${LABELS[name]}</span><small class="d-b tc-muted">${description}</small>
        <input
          type=${type === 'number' ? 'number' : 'text'}
          min=${type === 'number' ? 0 : nothing}
          step=${type === 'number' ? 1 : nothing}
          .value=${String(value ?? '')}
          @input=${event => this.set(name, type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
        />
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
              ${group.note ? html`<p class="tc-muted mb">${group.note}</p>` : nothing}
              ${group.names.map(name => this.settings.find(setting => setting.name === name)).filter(Boolean).map(setting => this.#renderField(setting))}
            `)}
            ${this.error ? html`<p class="tc-danger mb" role="alert">${this.error}</p>` : nothing}
            ${this.notice ? html`<p class="tc-success mb" role="status">${this.notice}</p>` : nothing}
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
