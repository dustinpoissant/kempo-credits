import { DECLARED_SETTINGS } from '../../../server/utils/config/declared.js';
import { SETTING_NAMES, readConfig } from '../../../server/utils/config/settings.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  The settings screen: each setting's current value with its declared type and description.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'credits:settings');
  if(gateError) return refuse(response, gateError);

  const config = await readConfig();

  response.json({
    settings: Object.entries(SETTING_NAMES).map(([key, name]) => ({
      name,
      value: config[key],
      type: DECLARED_SETTINGS.get(name)?.type || 'string',
      description: DECLARED_SETTINGS.get(name)?.description || '',
    })),
  });
};
