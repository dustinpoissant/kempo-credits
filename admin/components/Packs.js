import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { createPack, deletePack, listAllPacks, updatePack } from '/credits/sdk.js';
import { formatAmount, formatCredits, fromMinor, toMinor } from '/credits/utils/format.js';

/*
  The packs users can buy. A pack's price is the only thing a purchase ever charges — the buyer's
  browser names a pack, never an amount — so this screen is where every price on the site is set.

  Changing a pack never changes a purchase already made from it. A pack somebody has bought can be
  disabled, but not deleted, because its receipts point at it.

  The price is typed in the currency's normal units (4.99) and stored in its smallest (499). Each
  card charge costs a fixed fee as well as a percentage, which is the reason to sell credits in packs
  at all; the smallest pack is where that fee bites hardest.
*/

const blank = () => ({ id: '', name: '', description: '', credits: '', price: '', currency: '', sort: 0, enabled: true });

export default class Packs extends ShadowComponent {
  static properties = {
    packs: { type: Array, state: true },
    editing: { type: Object, state: true },
    busy: { type: Boolean, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.packs = [];
    this.editing = null;
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
    const [error, data] = await listAllPacks();
    this.loading = false;
    this.error = error ? error.msg : '';
    this.packs = data?.packs || [];
  };

  /*
    Actions
  */

  edit = pack => {
    this.error = '';
    this.editing = pack
      ? { ...pack, price: String(fromMinor(pack.price, pack.currency)), credits: String(pack.credits), description: pack.description || '' }
      : blank();
  };

  set = (field, value) => {
    this.editing = { ...this.editing, [field]: value };
  };

  save = async event => {
    event.preventDefault();
    const currency = this.editing.currency || this.packs[0]?.currency || 'usd';
    const body = {
      name: this.editing.name,
      description: this.editing.description || null,
      credits: Number(this.editing.credits),
      price: toMinor(this.editing.price, currency),
      currency: this.editing.currency || undefined,
      sort: Number(this.editing.sort) || 0,
      enabled: this.editing.enabled,
    };

    this.busy = true;
    const [error] = this.editing.id ? await updatePack(this.editing.id, body) : await createPack(body);
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.editing = null;
    this.load();
  };

  toggle = async pack => {
    const [error] = await updatePack(pack.id, { enabled: !pack.enabled });
    this.error = error ? error.msg : '';
    this.load();
  };

  remove = async pack => {
    const [error] = await deletePack(pack.id);
    this.error = error ? error.msg : '';
    this.load();
  };

  /*
    Rendering
  */

  #renderForm(){
    const pack = this.editing;
    return html`
      <form class="card" @submit=${this.save}>
        <p><strong>${pack.id ? `Edit ${pack.name}` : 'New pack'}</strong></p>
        <div class="row -mx">
          <label class="span-6 m-span-12 px"><span class="d-b">Name</span>
            <input type="text" required maxlength="100" .value=${pack.name} @input=${event => this.set('name', event.target.value)} />
          </label>
          <label class="span-3 m-span-6 px"><span class="d-b">Credits</span>
            <input type="number" required min="1" step="1" .value=${pack.credits} @input=${event => this.set('credits', event.target.value)} />
          </label>
          <label class="span-3 m-span-6 px"><span class="d-b">Price${pack.currency ? ` (${pack.currency.toUpperCase()})` : ''}</span>
            <input type="number" required min="0.01" step="any" placeholder="4.99" .value=${pack.price} @input=${event => this.set('price', event.target.value)} />
          </label>
          <label class="span-9 m-span-12 px"><span class="d-b">Description <span class="tc-muted">optional, shown to buyers</span></span>
            <input type="text" maxlength="500" .value=${pack.description} @input=${event => this.set('description', event.target.value)} />
          </label>
          <label class="span-3 m-span-12 px"><span class="d-b">Order</span>
            <input type="number" step="1" .value=${String(pack.sort ?? 0)} @input=${event => this.set('sort', event.target.value)} />
          </label>
        </div>
        <label class="checkbox mb"><input type="checkbox" .checked=${pack.enabled} @change=${event => this.set('enabled', event.target.checked)} /> On sale</label>
        <p class="tc-muted">
          A card charge costs a fixed fee as well as a percentage (about $0.30 + 3% at Stripe), so a pack under a few
          dollars loses a large share of its price to it. The processor also has a minimum charge — $0.50 at Stripe.
        </p>
        ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
        <div class="d-f actions mb">
          <button class="primary" type="submit" ?disabled=${this.busy}>${this.busy ? 'Saving…' : 'Save'}</button>
          <button type="button" @click=${() => { this.editing = null; }}>Cancel</button>
        </div>
      </form>
    `;
  }

  render(){
    return html`
      ${this.editing ? this.#renderForm() : html`<button class="primary mb" @click=${() => this.edit(null)}><k-icon name="add"></k-icon> New pack</button>`}
      ${!this.editing && this.error ? html`<p class="tc-danger">${this.error}</p>` : nothing}
      ${this.loading && !this.packs.length ? html`<k-spinner></k-spinner>` : !this.packs.length ? html`
        <p class="tc-muted">No packs yet, so nothing can be bought. Add one to open the shop.</p>
      ` : html`
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Pack</th><th class="ta-right">Credits</th><th class="ta-right">Price</th><th>On sale</th><th></th></tr></thead>
            <tbody>
              ${this.packs.map(pack => html`
                <tr>
                  <td>${pack.name}${pack.description ? html`<span class="tc-muted d-b">${pack.description}</span>` : nothing}</td>
                  <td class="ta-right">${formatCredits(pack.credits)}</td>
                  <td class="ta-right">${formatAmount(pack.price, pack.currency)}</td>
                  <td>${pack.enabled ? html`<span class="tc-success">Yes</span>` : html`<span class="tc-muted">No</span>`}</td>
                  <td class="d-f actions">
                    <button class="link" @click=${() => this.edit(pack)}>Edit</button>
                    <button class="link" @click=${() => this.toggle(pack)}>${pack.enabled ? 'Disable' : 'Enable'}</button>
                    <button class="link tc-danger" @click=${() => this.remove(pack)}>Delete</button>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `}
    `;
  }

  static styles = css`
    :host { display: block; }
    .actions { gap: var(--spacer); align-items: center; }
  `;
}

customElements.define('k-cred-packs', Packs);
