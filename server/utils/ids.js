import crypto from 'crypto';

/*
  Ids carry a prefix saying what they are, so one pasted into a support ticket or a log line can
  be read without looking it up: `lot_`, `ent_`, `op_`, `pur_`, `pack_`, `clm_`.
*/
export default prefix => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
