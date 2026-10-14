import { checkRefund } from '../server/utils/purchases/refund.js';

/*
  kempo-payments' `payment:refunding`, fired in guard mode before any refund reaches the processor
  (kempo-payments 0.1.10 and later). Throwing refuses the refund with that error: a payment that
  bought credits is refundable only as far as the buyer still holds them. Every other payment passes.
*/
export default async data => {
  const [error] = await checkRefund(data);
  if(error) throw error;
};
