import type {Activity} from './schema.js';
// Provider event IDs are not a global namespace across scopes/log streams.
export const activityIdentity=(row:Pick<Activity,'provider'|'scope'|'id'>)=>JSON.stringify([row.provider,row.scope,row.id]);
