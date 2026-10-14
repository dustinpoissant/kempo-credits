import { createRequire } from 'module';

/*
  The declared settings, read from kempo-config.json itself, so the settings route can write each
  one with its declared type and description. `setSetting` stores exactly what it is handed — pass
  null for the description and the text kempo's own /admin/settings screen shows beside the setting
  is erased. Reading them from the config rather than restating them keeps one list.
*/
const require = createRequire(import.meta.url);
const config = require('../../../kempo-config.json');

export const DECLARED_SETTINGS = new Map((config.settings || []).map(setting => [setting.name, setting]));

export const typeOf = name => DECLARED_SETTINGS.get(name)?.type || 'string';
export const descriptionOf = name => DECLARED_SETTINGS.get(name)?.description || null;
