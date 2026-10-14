import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { newKey, sendCredits } from '/credits/sdk.js';
import { formatCredits } from '/credits/utils/format.js';

/*
  Sending some of your credits to another user, served at /credits/components/SendCredits.js.

  ```html
  <script type="module" src="/credits/components/SendCredits.js"></script>
  <k-cred-send></k-cred-send>                          <!-- asks who to send to, by email -->
  <k-cred-send to-user-id="u_123" to-name="Sam"></k-cred-send>   <!-- a fixed recipient, such as a profile page -->
  ```

  Fires `credits-sent` with `{ amount, to, balance }` once they have gone. Needs the signed-in user
  to hold `credits:transfer`, which a site has to give to a group on purpose; without it the server
  answers 403 and this says so.
*/
export default class SendCredits extends ShadowComponent {
  static properties = {
    toUserId: { type: String, attribute: 'to-user-id' },
    toName: { type: String, attribute: 'to-name' },
    email: { type: String, state: true },
    amount: { type: String, state: true },
    note: { type: String, state: true },
    busy: { type: Boolean, state: true },
    error: { type: String, state: true },
    sent: { type: Object, state: true },
  };

  // One key per submission, kept until it succeeds, so a retry of the same form is the same send.
  #key = newKey();

  constructor(){
    super();
    this.toUserId = '';
    this.toName = '';
    this.email = '';
    this.amount = '';
    this.note = '';
    this.busy = false;
    this.error = '';
    this.sent = null;
  }

  /*
    Actions
  */

  submit = async event => {
    event.preventDefault();
    this.busy = true;
    this.error = '';

    const [error, result] = await sendCredits({
      toUserId: this.toUserId || undefined,
      toEmail: this.toUserId ? undefined : this.email.trim(),
      amount: Number(this.amount),
      note: this.note.trim() || undefined,
      idempotencyKey: this.#key,
    });

    this.busy = false;

    if(error){
      this.error = error.code === 403
        ? 'You are not allowed to send credits on this site.'
        : error.code === 402 && error.transferable !== undefined && error.transferable < error.balance
          ? `Only ${formatCredits(error.transferable)} of your ${formatCredits(error.balance)} credits can be sent.`
          : error.code === 402 && error.balance !== undefined
            ? `You only have ${formatCredits(Math.max(error.balance, 0))} credits.`
            : error.msg;
      return;
    }

    this.sent = result;
    this.#key = newKey();
    this.dispatchEvent(new CustomEvent('credits-sent', { detail: result, bubbles: true, composed: true }));
  };

  again = () => {
    this.sent = null;
    this.amount = '';
    this.note = '';
    if(!this.toUserId) this.email = '';
  };

  /*
    Rendering
  */

  render(){
    if(this.sent){
      return html`
        <div class="card">
          <p class="tc-success"><strong><k-icon name="check_circle"></k-icon> Sent ${formatCredits(this.sent.amount)} credits to ${this.sent.to.name}.</strong></p>
          <button @click=${this.again}>Send more</button>
        </div>
      `;
    }

    return html`
      <form class="card" @submit=${this.submit}>
        ${this.toUserId
          ? html`<p>Send credits to <strong>${this.toName || 'this user'}</strong></p>`
          : html`
            <label class="mb"><span class="d-b">Their email address</span>
              <input type="email" required autocomplete="off" .value=${this.email} @input=${event => { this.email = event.target.value; }} />
            </label>
          `}
        <label class="mb"><span class="d-b">Credits</span>
          <input type="number" required min="1" step="1" .value=${this.amount} @input=${event => { this.amount = event.target.value; }} />
        </label>
        <label class="mb"><span class="d-b">Message <span class="tc-muted">optional</span></span>
          <input type="text" maxlength="500" .value=${this.note} @input=${event => { this.note = event.target.value; }} />
        </label>
        ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
        <button class="primary" type="submit" ?disabled=${this.busy}>${this.busy ? 'Sending…' : 'Send credits'}</button>
      </form>
    `;
  }
}

customElements.define('k-cred-send', SendCredits);
