import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { groupPermission, permission } from 'kempo/server/db/schema.js';
import { createIndexes } from './server/db/indexes.js';

/*
  Two things kempo-config.json cannot say.

  **The indexes**, which kempo's installer does not make from the schema — see server/db/indexes.js.
  One of them is what makes a retried request grant once, so if it cannot be made the install fails
  rather than going ahead without it.

  **Who may buy.** `credits:purchase` is what an ordinary signed-in user holds, so on the first
  install it is given to `system:Users`, the group every user is implicitly in. Only on the first
  install: a site that has since taken it away — to sell credits only to members, say — has decided
  that, and neither an update nor a reinstall undoes it. That is why this runs here, before kempo
  creates the declared permissions: the permission not existing yet is how a first install is told
  apart from a reinstall.
*/

const PURCHASE = 'credits:purchase';
const EVERYONE = 'system:Users';

const letEveryoneBuy = async () => {
  const [existing] = await db.select().from(permission).where(eq(permission.name, PURCHASE)).limit(1);
  if(existing) return;

  await db.insert(permission).values({
    name: PURCHASE,
    description: 'Buy credit packs for yourself. Every signed-in user holds this unless the site removes it',
    owner: 'kempo-credits',
    createdAt: new Date(),
  }).onConflictDoNothing();

  const [granted] = await db.select().from(groupPermission)
    .where(and(eq(groupPermission.groupName, EVERYONE), eq(groupPermission.permissionName, PURCHASE)))
    .limit(1);
  if(!granted){
    await db.insert(groupPermission).values({ id: randomUUID(), groupName: EVERYONE, permissionName: PURCHASE, createdAt: new Date() });
  }
};

export default async () => {
  await createIndexes();

  try {
    await letEveryoneBuy();
  } catch(error) {
    console.warn(`[kempo-credits] Could not let signed-in users buy credits (${error.message}). Give a group the credits:purchase permission to open the shop.`);
  }

  console.log('[kempo-credits] Installed. Add credit packs at /admin/extension/kempo-credits/ — nothing can be bought until one exists.');
};
