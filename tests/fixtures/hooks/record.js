/*
  Every hook fixture calls this. The ledger suites read the list back.
*/
export default (event, data) => {
  (globalThis.kempoCreditsHooks ||= []).push({ event, data });
};
