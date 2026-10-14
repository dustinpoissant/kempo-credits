import { readConfig as readPaymentsConfig } from 'kempo-payments/sdk';
import { readConfig } from '../../../server/utils/config/settings.js';
import { taxModule } from '../../../server/utils/purchases/tax.js';

/*
  What the buy page needs before anybody has chosen anything: whether a billing address is needed
  (it is when kempo-tax is enabled), the refund policy to show beside the price, and the currency.
  Public, like the packs: nothing here is about a user.
*/
export default async (request, response) => {
  const [config, payments, tax] = await Promise.all([readConfig(), readPaymentsConfig(), taxModule()]);

  response.json({
    taxed: !!tax,
    needsAddress: !!tax,
    refundPolicy: config.refundPolicy,
    currency: payments.currency,
  });
};
