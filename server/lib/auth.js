import crypto from 'node:crypto';
import { transaction, sha256, fail, username, uuid, audit } from './core.js';
import { hashPassword, verifyPassword, PASSWORD_GUIDANCE } from './passwords.js';
import { PERMISSIONS, effectivePermissions, validateOverrides } from '../../dashboard/permissions.js';

export function installAuth(app, db, origin) {
 const secure = process.env.COOKIE_SECURE !== 'false';
 if (!origin || (secure && new URL(origin).protocol !== 'https:')) throw new Error('APP_ORIGIN must be a trusted HTTPS origin');
 const cookieOptions = {httpOnly:true,secure,sameSite:'strict',path:'/'};
 const clear = res => { for(const name of ['ex_session','ex_at','ex_rt']) res.clearCookie(name,cookieOptions); };
 const revoke = async (tx,id) => {
  await tx.query('UPDATE users SET credential_version=credential_version+1 WHERE id=$1',[id]);
  await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);
  await tx.query('UPDATE password_tokens SET revoked_at=now() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[id]);
  await tx.query("SELECT pg_notify('auth_changed',$1)",[id]);
 };
 const sessionUser = async token => {
  if(typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const {rows} = await db.query(`UPDATE sessions s SET last_seen_at=now() FROM users u
   WHERE s.token_hash=$1 AND u.id=s.user_id AND u.is_active AND NOT u.pending_setup
   AND u.credential_version=s.credential_version AND s.expires_at>now()
   AND s.last_seen_at>now()-interval '30 minutes'
   RETURNING u.id,u.username,u.display_name,u.is_superadmin,s.reauthenticated_at,s.token_hash`,[sha256(token)]);
  return rows[0] || null;
 };
 const auth = async (req,res,next) => {
  req.user = await sessionUser(req.cookies.ex_session);
  if(!req.user) { clear(res); return res.status(401).json({error:'unauthenticated'}); }
  req.user.sub=req.user.id; req.user.sa=req.user.is_superadmin;
  next();
 };
 const admin = (req,res,next) => req.user.is_superadmin ? next() : res.status(403).json({error:'Administrator access required.'});
 const recent = (req,res,next) => Date.now()-new Date(req.user.reauthenticated_at).getTime()<5*60_000 ? next() : res.status(403).json({error:'reauthentication_required'});
 const createSession = async (tx,req,res,user) => {
  const token=crypto.randomBytes(32).toString('hex');
  if(req.cookies.ex_session) await tx.query('DELETE FROM sessions WHERE token_hash=$1',[sha256(req.cookies.ex_session)]);
  await tx.query(`INSERT INTO sessions(token_hash,user_id,credential_version,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')`,[sha256(token),user.id,user.credential_version]);
  clear(res); res.cookie('ex_session',token,{...cookieOptions,maxAge:12*3600_000});
 };
 // Same-origin custom header plus strict Origin validation prevents cross-site form/JSON mutations.
 app.use('/api',(req,res,next) => {
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && (req.get('Origin')!==origin || req.get('X-Excalidraw-Request')!=='1')) return res.status(403).json({error:'Invalid request origin.'});
  next();
 });
 const limiter = action => async (req,res,next) => {
  const keys=[`${action}:source:${req.ip}`,`${action}:account:${sha256(String(req.body?.username ?? req.body?.token ?? req.user?.id ?? '').trim().toLowerCase())}`];
  for(const [index,key] of keys.entries()) {
   const {rows}=await db.query(`INSERT INTO auth_rate_limits(key,hits,expires_at) VALUES($1,1,now()+interval '15 minutes')
    ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.hits+1 END,
    expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END RETURNING hits`,[key]);
   if(rows[0].hits>(index===0?60:20)) return res.status(429).json({error:'Too many attempts. Try again in 15 minutes.'});
  }
  next();
 };
 const dummyHash = hashPassword(crypto.randomBytes(32).toString('hex'));
 app.post('/api/auth/login',limiter('login'),async(req,res)=>{
  const name=typeof req.body?.username==='string'?req.body.username.trim():'';
  const result=await transaction(db,async tx=>{
   const {rows}=await tx.query('SELECT * FROM users WHERE lower(username::text)=lower($1) FOR UPDATE',[name]);
   const user=rows[0];
   const valid=await verifyPassword(user?.password_hash || await dummyHash,req.body?.password);
   if(!valid || !user?.is_active || user.pending_setup) { await audit(tx,user?.id || null,'auth.login',user?.id || null,'denied'); return null; }
   await tx.query('UPDATE users SET last_login_at=now() WHERE id=$1',[user.id]);
   await createSession(tx,req,res,user); await audit(tx,user.id,'auth.login',user.id); return user;
  });
  if(!result) return res.status(401).json({error:'Invalid username or password.'});
  res.json({ok:true});
 });
 app.get('/api/me',auth,(req,res)=>res.json({id:req.user.id,username:req.user.username,display_name:req.user.display_name,is_superadmin:req.user.is_superadmin,password_guidance:PASSWORD_GUIDANCE}));
 app.get('/api/permissions',auth,(_req,res)=>res.json(PERMISSIONS));
 app.post('/api/auth/logout',async(req,res)=>{ if(req.cookies.ex_session) await db.query('DELETE FROM sessions WHERE token_hash=$1',[sha256(req.cookies.ex_session)]); clear(res); res.json({ok:true}); });
 app.post('/api/auth/reauthenticate',auth,limiter('reauth'),async(req,res)=>{
  await transaction(db,async tx=>{
   const {rows}=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   if(!rows[0].is_active || !await verifyPassword(rows[0].password_hash,req.body?.password)) fail(403,'Invalid username or password.');
   await createSession(tx,req,res,rows[0]);
  }); res.json({ok:true});
 });
 const recoveryMessage='If this username belongs to an account, a reset request has been recorded. Contact your administrator to verify your identity and receive a reset link.';
 app.post('/api/auth/forgot-password',limiter('recovery'),async(req,res)=>{
  await db.query(`INSERT INTO password_reset_requests(user_id) SELECT id FROM users WHERE lower(username::text)=lower($1) AND is_active AND NOT pending_setup ON CONFLICT DO NOTHING`,[typeof req.body?.username==='string'?req.body.username.trim():'']);
  res.json({message:recoveryMessage});
 });
 const tokenRow = async (tx,token,purpose,lock=false) => {
  if(!['setup','reset'].includes(purpose) || typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) fail(400,'This reset link is invalid or has expired. Request a new link.');
  // Lock user first, consistently with issuance/revocation, then re-read token.
  const match=await tx.query('SELECT user_id FROM password_tokens WHERE token_hash=$1',[sha256(token)]);
  if(lock && match.rows[0]) await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[match.rows[0].user_id]);
  const {rows}=await tx.query(`SELECT t.*,u.pending_setup FROM password_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.purpose=$2 AND t.expires_at>now() AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND u.is_active`,[sha256(token),purpose]);
  if(!rows[0] || (purpose==='setup')!==rows[0].pending_setup) fail(400,'This reset link is invalid or has expired. Request a new link.');
  return rows[0];
 };
 app.post('/api/auth/check-token',limiter('token-check'),async(req,res)=>{ await tokenRow(db,req.body?.token,req.body?.purpose); res.json({ok:true}); });
 app.post('/api/auth/reset-password',limiter('reset'),async(req,res)=>{
  const {token,purpose,password,confirmation}=req.body || {};
  if(password!==confirmation) fail(400,'Passwords do not match.');
  const hash=await hashPassword(password);
  await transaction(db,async tx=>{
   const row=await tokenRow(tx,token,purpose,true);
   await tx.query('UPDATE password_tokens SET consumed_at=now() WHERE token_hash=$1',[row.token_hash]);
   await tx.query('UPDATE users SET password_hash=$2,pending_setup=false WHERE id=$1',[row.user_id,hash]);
   await revoke(tx,row.user_id);
   await tx.query("UPDATE password_reset_requests SET status='resolved',resolved_at=now(),resolved_by=$2 WHERE user_id=$1 AND status='pending'",[row.user_id,row.issued_by]);
   await audit(tx,row.user_id,`password.${purpose}.complete`,row.user_id);
  }); clear(res); res.json({message:'Password updated. Sign in with your username and new password.'});
 });
 app.post('/api/me/password',auth,limiter('change'),async(req,res)=>{
  const {current_password,new_password,confirmation}=req.body || {};
  if(new_password!==confirmation) fail(400,'Passwords do not match.');
  const hash=await hashPassword(new_password);
  await transaction(db,async tx=>{
   const {rows}=await tx.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   if(!await verifyPassword(rows[0].password_hash,current_password)) fail(403,'Current password is incorrect.');
   await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[req.user.id,hash]); await revoke(tx,req.user.id); await audit(tx,req.user.id,'password.change',req.user.id);
  }); clear(res); res.json({message:'Password updated. Sign in with your username and new password.'});
 });
 const workspaceAccess = async (user,workspace,tx=db) => {
  if(!uuid(workspace)) fail(404,'Workspace not found.');
  const {rows}=await tx.query(`SELECT w.id,m.role,coalesce((SELECT jsonb_object_agg(permission,effect) FROM permission_overrides p WHERE p.workspace_id=w.id AND p.user_id=$2),'{}') AS overrides
    FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$2 WHERE w.id=$1`,[workspace,user.id]);
  if(!rows[0] || (!user.is_superadmin && !rows[0].role)) fail(404,'Workspace not found.');
  return effectivePermissions(rows[0].role,rows[0].overrides,user.is_superadmin);
 };
 const permit=async(user,workspace,key,tx=db)=>{const permissions=await workspaceAccess(user,workspace,tx); if(!permissions[key]) fail(403,'You do not have permission for this action.'); return permissions;};
 app.get('/api/workspaces',auth,async(req,res)=>{
  const {rows}=await db.query(`SELECT w.id,w.name,w.slug,m.role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$1 WHERE $2 OR m.user_id IS NOT NULL ORDER BY w.created_at`,[req.user.id,req.user.is_superadmin]);
  for(const row of rows) row.permissions=await workspaceAccess(req.user,row.id);
  res.json(rows);
 });
 const issue=async(tx,id,purpose,actor)=>{
  await tx.query('UPDATE password_tokens SET revoked_at=now() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[id]);
  const token=crypto.randomBytes(32).toString('hex');
  const {rows}=await tx.query(`INSERT INTO password_tokens(token_hash,user_id,purpose,expires_at,issued_by) VALUES($1,$2,$3,now()+$4::interval,$5) RETURNING expires_at`,[sha256(token),id,purpose,purpose==='setup'?'24 hours':'30 minutes',actor]);
  await audit(tx,actor,`password.${purpose}.issue`,id);
  return {url:`${origin}/${purpose==='setup'?'set':'reset'}-password#token=${token}`,expires_at:rows[0].expires_at};
 };
 const assignments=async(tx,id,values,actor)=>{
  if(!Array.isArray(values)) fail(400,'Workspace assignments are required.');
  const seen=new Set();
  for(const item of values) {
   if(!uuid(item.workspace_id)||seen.has(item.workspace_id)||!['editor','viewer'].includes(item.role)) fail(400,'Invalid workspace assignment.');
   seen.add(item.workspace_id); try {validateOverrides(item.role,item.overrides || {});}catch(e){fail(400,e.message);}
  }
  await tx.query('DELETE FROM workspace_members WHERE user_id=$1',[id]);
  for(const item of values){
   await tx.query('INSERT INTO workspace_members(workspace_id,user_id,role,added_by) VALUES($1,$2,$3,$4)',[item.workspace_id,id,item.role,actor]);
   for(const [key,effect] of Object.entries(item.overrides || {})) await tx.query('INSERT INTO permission_overrides(user_id,workspace_id,permission,effect) VALUES($1,$2,$3,$4)',[id,item.workspace_id,key,effect]);
  }
 };
 app.get('/api/admin/users',auth,admin,async(req,res)=>{
  const limit=25,offset=Math.max(0,Number(req.query.page)||0)*limit;
  const {rows}=await db.query(`SELECT u.id,u.username,u.display_name,u.is_superadmin,u.is_active,u.pending_setup,u.last_login_at,
   coalesce((SELECT jsonb_agg(jsonb_build_object('workspace_id',m.workspace_id,'role',CASE WHEN m.role IN ('owner','admin') THEN 'editor' ELSE m.role::text END,'overrides',coalesce((SELECT jsonb_object_agg(permission,effect) FROM permission_overrides p WHERE p.user_id=u.id AND p.workspace_id=m.workspace_id),'{}'))) FROM workspace_members m WHERE m.user_id=u.id),'[]') AS assignments,
   count(*) OVER() AS total FROM users u WHERE username ILIKE $1 OR display_name ILIKE $1 ORDER BY u.is_superadmin DESC, username LIMIT $2 OFFSET $3`,[`%${String(req.query.search || '').slice(0,100)}%`,limit,offset]);
  res.json({items:rows,total:Number(rows[0]?.total || 0),page:offset/limit});
 });
 app.post('/api/admin/users',auth,admin,recent,async(req,res)=>{
  const name=username(req.body?.username);
  if(req.body.is_superadmin && req.body.confirm_global_admin!==true) fail(400,'Confirm administrator access to all application workspaces.');
  const result=await transaction(db,async tx=>{
   const {rows}=await tx.query(`INSERT INTO users(username,display_name,is_superadmin,pending_setup) VALUES($1,$2,$3,true) RETURNING id`,[name,String(req.body.display_name || '').slice(0,120),req.body.is_superadmin===true]);
   const id=rows[0].id; await assignments(tx,id,req.body.assignments,req.user.id); await audit(tx,req.user.id,'user.create',id);
   return {id,...await issue(tx,id,'setup',req.user.id)};
  }); res.status(201).json(result);
 });
 app.patch('/api/admin/users/:id',auth,admin,recent,async(req,res)=>{
  if(!uuid(req.params.id)) fail(404,'User not found.');
  const name=username(req.body?.username);
  await transaction(db,async tx=>{
   // Serialize all admin-set changes, including concurrent demotions of different admins.
   await tx.query('SELECT pg_advisory_xact_lock(4271901)');
   const {rows}=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]); const old=rows[0]; if(!old) fail(404,'User not found.');
   const active=req.body.is_active===true, sa=req.body.is_superadmin===true;
   if(sa && !old.is_superadmin && req.body.confirm_global_admin!==true) fail(400,'Confirm administrator access to all application workspaces.');
   if(old.is_superadmin && old.is_active && !old.pending_setup && (!active||!sa)) {
    const count=await tx.query('SELECT count(*)::int AS n FROM users WHERE is_active AND is_superadmin AND NOT pending_setup');
    if(count.rows[0].n<=1) fail(409,'The last active administrator cannot be deactivated or demoted.');
   }
   await tx.query('UPDATE users SET username=$2,display_name=$3,is_superadmin=$4,is_active=$5 WHERE id=$1',[old.id,name,String(req.body.display_name || '').slice(0,120),sa,active]);
   await assignments(tx,old.id,req.body.assignments,req.user.id); await revoke(tx,old.id); await audit(tx,req.user.id,'user.permissions_status.update',old.id);
  }); res.json({ok:true});
 });
 app.delete('/api/admin/users/:id',auth,admin,recent,async(req,res)=>{
  if(!uuid(req.params.id)) fail(404,'User not found.');
  if(req.params.id===req.user.id) fail(409,'You cannot delete your own account.');
  await transaction(db,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(4271901)');
   const {rows}=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]); const old=rows[0]; if(!old) fail(404,'User not found.');
   if(old.is_superadmin && old.is_active && !old.pending_setup) {
    const count=await tx.query('SELECT count(*)::int AS n FROM users WHERE is_active AND is_superadmin AND NOT pending_setup');
    if(count.rows[0].n<=1) fail(409,'The last active administrator cannot be deleted.');
   }
   const id=old.id, heir=req.user.id;
   await revoke(tx,id);
   // Only the account goes. Drawings, files, collections and history stay; anything the
   // account owned moves to the deleting administrator so nothing becomes unreachable.
   await tx.query('UPDATE scenes SET owner_id=$2 WHERE owner_id=$1',[id,heir]);
   await tx.query('UPDATE scenes SET private_owner_id=$2 WHERE private_owner_id=$1',[id,heir]);
   await tx.query('UPDATE workspaces SET owner_id=$2 WHERE owner_id=$1',[id,heir]);
   await tx.query('UPDATE legacy_scene_visibility SET visible_to=$2 WHERE visible_to=$1',[id,heir]);
   await tx.query('UPDATE collection_drawings SET added_by=NULL WHERE added_by=$1',[id]);
   await tx.query('UPDATE workspace_activity SET actor_id=NULL WHERE actor_id=$1',[id]);
   await tx.query('UPDATE password_tokens SET issued_by=NULL WHERE issued_by=$1',[id]);
   await tx.query('UPDATE password_reset_requests SET resolved_by=NULL WHERE resolved_by=$1',[id]);
   await tx.query('DELETE FROM password_tokens WHERE user_id=$1',[id]);
   await tx.query('DELETE FROM password_reset_requests WHERE user_id=$1',[id]);
   await tx.query('DELETE FROM creation_requests WHERE user_id=$1',[id]);
   await tx.query('DELETE FROM users WHERE id=$1',[id]);
   // The username is kept in the audit entry because the account row no longer exists.
   await tx.query("INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'user.delete','user',$2,$3)",[heir,id,{outcome:'success',username:old.username}]);
  }); res.json({ok:true});
 });
 app.post('/api/admin/users/:id/password-link',auth,admin,recent,async(req,res)=>{
  if(req.body?.identity_verified!==true) fail(400,'Verify identity through an established channel before issuing a private link.');
  const result=await transaction(db,async tx=>{
   const {rows}=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);
   if(!rows[0]?.is_active) fail(404,'Eligible user not found.');
   return issue(tx,req.params.id,rows[0].pending_setup?'setup':'reset',req.user.id);
  }); res.json(result);
 });
 app.get('/api/admin/reset-requests',auth,admin,async(req,res)=>{
  const {rows}=await db.query(`SELECT r.*,u.username FROM password_reset_requests r JOIN users u ON u.id=r.user_id WHERE ($1::text IS NULL OR r.status=$1) ORDER BY r.created_at DESC LIMIT 25 OFFSET $2`,[req.query.status || null,Math.max(0,Number(req.query.page)||0)*25]); res.json(rows);
 });
 app.post('/api/admin/reset-requests/:id/reject',auth,admin,recent,async(req,res)=>{await db.query("UPDATE password_reset_requests SET status='rejected',resolved_at=now(),resolved_by=$2 WHERE id=$1 AND status='pending'",[req.params.id,req.user.id]); await audit(db,req.user.id,'password.request.reject',req.params.id); res.json({ok:true});});
 app.get('/api/admin/audit-log',auth,admin,async(req,res)=>{
  const {rows}=await db.query(`SELECT a.id,a.action,a.target_id,a.created_at,a.metadata->>'outcome' AS outcome,u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE a.action ILIKE $1 AND ($2::text IS NULL OR a.metadata->>'outcome'=$2) ORDER BY a.id DESC LIMIT 50 OFFSET $3`,[`%${String(req.query.action||'').slice(0,100)}%`,req.query.outcome||null,Math.max(0,Number(req.query.page)||0)*50]); res.json(rows);
 });
 return {auth,admin,recent,permit,workspaceAccess,sessionUser,revoke};
}
