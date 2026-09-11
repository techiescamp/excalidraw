import crypto from 'node:crypto';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const transaction = async (db, run) => {
 const client = await db.connect();
 try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
 catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
};
export const audit = (db, actor, action, target, outcome='success') => db.query(
 'INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,$2,\'user\',$3,$4)',
 [actor,action,target,{outcome}]);
export const username = value => {
 if(typeof value !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(value.trim())) fail(400,'Username must be 3–32 ASCII letters, digits, periods, underscores or hyphens.');
 return value.trim();
};
