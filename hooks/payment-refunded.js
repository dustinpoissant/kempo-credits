import { onPaymentRefunded } from '../server/utils/purchases/payments.js';

/*
  kempo-payments' `payment:refunded`. Every payment on the site fires it; only kempo-credits' own are
  acted on. See server/utils/purchases/payments.js.
*/
export default async data => {
  const [error] = await onPaymentRefunded(data);
  if(error) console.error(`[kempo-credits] payment:refunded for ${data?.payment?.reference || 'an unknown purchase'} was not applied: ${error.msg}`);
};
