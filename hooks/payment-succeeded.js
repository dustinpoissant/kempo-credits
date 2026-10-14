import { onPaymentSucceeded } from '../server/utils/purchases/payments.js';

/*
  kempo-payments' `payment:succeeded`. Every payment on the site fires it; only kempo-credits' own are
  acted on. See server/utils/purchases/payments.js.
*/
export default async data => {
  const [error] = await onPaymentSucceeded(data);
  if(error) console.error(`[kempo-credits] payment:succeeded for ${data?.payment?.reference || 'an unknown purchase'} was not applied: ${error.msg}`);
};
