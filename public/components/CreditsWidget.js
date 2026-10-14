import DashboardWidget from '/kempo/components/DashboardWidget.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { getSummary } from '/credits/sdk.js';
import { formatCredits } from '/credits/utils/format.js';

/*
  The dashboard's view of credits: how many are held, by how many users, and anybody who owes
  credits after a refund — the one thing here that needs a person.
*/
export default class CreditsWidget extends DashboardWidget {
  static properties = {
    ...DashboardWidget.properties,
    summary: { state: true },
  };

  constructor(){
    super();
    this.summary = null;
    this.cta = { label: 'View credits', icon: 'toll', href: '/admin/extension/kempo-credits/' };
  }

  /*
    Public Methods
  */

  load = async () => {
    this.summary = await this.unwrap(getSummary());
  };

  /*
    Rendering
  */

  renderContent(){
    const { credits } = this.summary;

    return html`
      <div class="d-f mb">
        <div class="flex"><div class="h2 m0">${formatCredits(credits.total)}</div><div class="tc-muted">Credits held</div></div>
        <div class="flex"><div class="h2 m0">${formatCredits(credits.holders)}</div><div class="tc-muted">User${credits.holders === 1 ? '' : 's'} holding some</div></div>
      </div>
      ${credits.owing ? html`
        <p class="tc-warning m0" role="alert">
          ${formatCredits(credits.owing)} user${credits.owing === 1 ? '' : 's'} owe${credits.owing === 1 ? 's' : ''} ${formatCredits(credits.owed)} credits after a refund.
        </p>
      ` : nothing}
    `;
  }
}

customElements.define('k-cred-widget', CreditsWidget);
