// The demo ids, named apart from the generators that build them.
//
// The host needs to know which ids belong to the current generation of each sample — to purge stale
// saved copies on startup, and to tell a deep link at an old id from one at a live one. Reading that
// off `createDemo().id` meant building the entire Stockmann campus, a thousand objects, to learn a
// string; it also meant every demo generator sat in the eager bundle of a page that mostly shows a
// picker. Generators import their id from here, so there is still exactly one place it is written.
export const STOCKMANN_ID = 'demo-campus-13';
export const SILO_ID = 'demo-silo-5';
export const BACKROOMS_ID = 'sample-backrooms-v7';
/** Every id the built-in samples answer for right now. */
export const DEMO_IDS = [STOCKMANN_ID, SILO_ID, BACKROOMS_ID];
