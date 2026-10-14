import { getAllCurrentUserPermissions } from '/kempo/sdk.js';

/*
  The signed-in administrator's permissions, fetched once per page and shared by every component on
  it. Only used to decide which buttons to show: each route checks the permission again, and that
  check is the one that matters.
*/
let pending = null;

export default () => {
  pending ||= getAllCurrentUserPermissions().then(([error, data]) => new Set(error ? [] : data?.permissions || []));
  return pending;
};
