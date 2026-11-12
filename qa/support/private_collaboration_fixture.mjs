/* TEST ONLY: local D1 and R2 fixtures. Never import from application or server deployment code. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
export function createCollaborationFixture() {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(fs.readFileSync(new URL('../../server/migrations/0001_private_collaboration.sql',import.meta.url),'utf8'));
  function prepare(sql){let values=[];return {bind(...args){values=args;return this;},async first(){return db.prepare(sql).get(...values)||null;},async all(){return {results:db.prepare(sql).all(...values)};},_run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};},async run(){return this._run();}};}
  const DB={prepare,async batch(statements){db.exec('BEGIN');try{const results=statements.map(statement=>statement._run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const objects=new Map();const BUCKET={async put(key,body,options){const bytes=new Uint8Array(await new Response(body).arrayBuffer());const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));assert.deepEqual(digest,new Uint8Array(Buffer.from(options.sha256,'hex')));objects.set(key,bytes);return {key};},async delete(key){objects.delete(key);},async get(key){return objects.has(key)?{body:new Blob([objects.get(key)]).stream()}:null;}};
  return {db,objects,env:{DB,BUCKET},close:()=>db.close()};
}
