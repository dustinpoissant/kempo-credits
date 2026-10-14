import { onPaymentFailed } from '../server/utils/purchases/payments.js';

/*
  kempo-payments' `payment:failed`. Every payment on the site fires it; only kempo-credits' own are
  acted on. See server/utils/purchases/payments.js.
*/
export default async data => {
  const [error] = await onPaymentFailed(data);
  if(error) console.error(`[kempo-credits] payment:failed for ${data?.payment?.reference || 'an unknown purchase'} was not applied: ${error.msg}`);
};
