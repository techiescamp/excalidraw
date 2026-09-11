// Host-only bootstrap/recovery. Credentials are never accepted on argv.
import pg from 'pg';
import readline from 'node:readline';
import {Writable} from 'node:stream';
import {hashPassword,PASSWORD_GUIDANCE} from '../lib/passwords.js';
import {username,transaction,audit} from '../lib/core.js';
const bootstrap=process.argv[2]==='--bootstrap';
const name=username(process.argv[bootstrap?3:2]);
if(!process.stdin.isTTY)throw new Error('Run from a terminal for secure password prompting.');
const muted=new Writable({write(chunk,encoding,done){done();}});
const rl=readline.createInterface({input:process.stdin,output:muted,terminal:true});
const ask=question=>new Promise(resolve=>{process.stdout.write(question);rl.question('',value=>{process.stdout.write('\n');resolve(value);});});
console.log(PASSWORD_GUIDANCE);
const password=await ask('New password: '),confirmation=await ask('Repeat password: ');rl.close();
if(password!==confirmation)throw new Error('Passwords do not match.');
const hash=await hashPassword(password);
const db=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
 await transaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4271901)');
  let id;
  if(bootstrap){
   if((await tx.query('SELECT 1 FROM users WHERE is_superadmin AND is_active AND NOT pending_setup')).rowCount)throw new Error('An active administrator already exists. Use recovery instead.');
   const result=await tx.query('INSERT INTO users(username,password_hash,is_superadmin) VALUES($1,$2,true) RETURNING id',[name,hash]);id=result.rows[0].id;
   const workspace=await tx.query("INSERT INTO workspaces(name,slug,owner_id) VALUES('My workspace',$1,$2) RETURNING id",['workspace-'+id.slice(0,8),id]);
   await tx.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace.rows[0].id,id]);
  }else{
   const result=await tx.query('UPDATE users SET password_hash=$2,pending_setup=false,is_active=true,credential_version=credential_version+1 WHERE lower(username::text)=lower($1) RETURNING id',[name,hash]);
   if(!result.rows[0])throw new Error('Username not found.');id=result.rows[0].id;
  }
  await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);
  await tx.query('UPDATE password_tokens SET revoked_at=now() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[id]);
  await tx.query("SELECT pg_notify('auth_changed',$1)",[id]);
  await audit(tx,null,bootstrap?'operator.bootstrap':'operator.password.recovery',id);
 });console.log('Password set and sessions revoked.');
}finally{await db.end();}
