import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

/** Single coordinator writer; transactions contain facts/effects, never network operations. */
export class Store {
  constructor(file){
    mkdirSync(dirname(file),{recursive:true});this.db=new DatabaseSync(file);this.depth=0;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(type TEXT NOT NULL,id TEXT NOT NULL,status TEXT,value TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(type,id));
      CREATE INDEX IF NOT EXISTS records_status ON records(type,status,updated);
      CREATE TABLE IF NOT EXISTS effects(kind TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,seq INTEGER PRIMARY KEY AUTOINCREMENT,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(kind,key));
      CREATE INDEX IF NOT EXISTS effects_due ON effects(status,due,seq);`);
  }
  atomic(fn){
    if(this.depth)return fn();this.db.exec('BEGIN IMMEDIATE');this.depth++;
    try{const r=fn();if(r?.then)throw Error('Transactions must be synchronous');this.db.exec('COMMIT');return r;}
    catch(e){this.db.exec('ROLLBACK');throw e}finally{this.depth--}
  }
  get(type,id){const row=this.db.prepare('SELECT value FROM records WHERE type=? AND id=?').get(type,id);return row?JSON.parse(row.value):null;}
  put(type,id,value){this.db.prepare('INSERT INTO records(type,id,status,value,updated) VALUES(?,?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET status=excluded.status,value=excluded.value,updated=excluded.updated').run(type,id,value.status||null,JSON.stringify(value),Date.now());return value;}
  list(type,status){return (status?this.db.prepare('SELECT value FROM records WHERE type=? AND status=? ORDER BY updated,id').all(type,status):this.db.prepare('SELECT value FROM records WHERE type=? ORDER BY updated,id').all(type)).map(x=>JSON.parse(x.value));}
  remove(type,id){return this.db.prepare('DELETE FROM records WHERE type=? AND id=?').run(type,id).changes>0;}
  enqueue(kind,key,payload){this.db.prepare(`INSERT INTO effects(kind,key,payload) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET payload=excluded.payload,generation=generation+1,status='pending',due=0,error=NULL`).run(kind,key,JSON.stringify(payload));}
  effects(){return this.db.prepare('SELECT * FROM effects ORDER BY seq').all().map(x=>({...x,payload:JSON.parse(x.payload)}));}
  claimEffect(kind,key){return this.atomic(()=>{const r=this.db.prepare("SELECT * FROM effects WHERE kind=? AND key=? AND status='pending' AND due<=?").get(kind,key,Date.now());if(!r)return null;this.db.prepare("UPDATE effects SET status='inflight' WHERE seq=?").run(r.seq);return {...r,payload:JSON.parse(r.payload)};});}
  settleEffect(row){return this.db.prepare('DELETE FROM effects WHERE seq=? AND generation=?').run(row.seq,row.generation).changes>0;}
  deferEffect(row,error,{uncertain=false,delay=5000}={}){return this.db.prepare('UPDATE effects SET status=?,attempts=attempts+1,due=?,error=? WHERE seq=? AND generation=?').run(uncertain?'uncertain':'pending',Date.now()+delay,String(error).slice(0,1000),row.seq,row.generation).changes>0;}
  cancelEffect(kind,key){this.db.prepare('DELETE FROM effects WHERE kind=? AND key=?').run(kind,key);}
  close(){this.db.close()}
}
