import DashboardWidget from '/kempo/components/DashboardWidget.js';
import { html, nothing } from '/kempo-ui/lit-all.min.js';
import { getSummary } from '/credits/sdk.js';
import { formatAmount, formatCredits } from '/credits/utils/format.js';

/*
  The dashboard's view of credits: what users hold — bought credits apart, because those are a
  balance the site owes — what has sold in the last 30 days, and the things a person has to look at.
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
    const { credits, purchases } = this.summary;
    const attention = credits.owing + purchases.needsAttention + purchases.blockedLastDay;

    return html`
      <div class="d-f mb">
        <div class="flex"><div class="h2 m0">${formatCredits(credits.paid)}</div><div class="tc-muted">Bought, unspent</div></div>
        <div class="flex"><div class="h2 m0">${formatCredits(credits.promo)}</div><div class="tc-muted">Promo, unspent</div></div>
        ${purchases.sales.map(sale => html`
          <div class="flex"><div class="h2 m0">${formatAmount(sale.total - sale.refunded, sale.currency)}</div><div class="tc-muted">Taken in ${purchases.days} days, with tax, less refunds</div></div>
        `)}
      </div>
      ${attention ? html`
        <p class="tc-warning m0" role="alert">
          ${credits.owing ? html`${credits.owing} owing after a refund. ` : nothing}
          ${purchases.needsAttention ? html`${purchases.needsAttention} purchase${purchases.needsAttention === 1 ? '' : 's'} to check. ` : nothing}
          ${purchases.blockedLastDay ? html`${purchases.blockedLastDay} blocked in a day.` : nothing}
        </p>
      ` : nothing}
    `;
  }
}

customElements.define('k-cred-widget', CreditsWidget);
