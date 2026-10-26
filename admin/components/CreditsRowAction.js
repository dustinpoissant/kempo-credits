import ButtonControl from '/kempo-ui/components/controls/ButtonControl.js';
import { html } from '/kempo-ui/lit-all.min.js';

/*
  A row action (Claw back, Reverse). It shows only on the rows whose `actions` list names it, and it reports
  the choice as a `creditsAction` event on the table: { action, record }. The page owns the dialog.

    <k-cred-row-action slot="after" action="reverse" label="Reverse"></k-cred-row-action>
*/
export default class CreditsRowAction extends ButtonControl {
  static properties = {
    ...ButtonControl.properties,
    action: { type: String },
    label: { type: String },
  };

  constructor(){
    super();
    this.action = '';
    this.label = '';
  }

  get record(){
    const index = this.closest('.record')?.dataset?.index;
    return index === undefined ? null : this.host?.records?.[index] ?? null;
  }

  get shown(){
    return Boolean(this.record?.actions?.includes(this.action));
  }

  handleAction(){
    if(!this.shown) return;
    this.host.dispatchEvent(new CustomEvent('creditsAction', { detail: { action: this.action, record: this.record } }));
  }

  render(){
    return this.shown ? html`<slot>${this.label}</slot>` : html``;
  }
}

customElements.define('k-cred-row-action', CreditsRowAction);
