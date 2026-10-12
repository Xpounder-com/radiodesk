import test from 'node:test';
import assert from 'node:assert/strict';
import { MutationQueue } from '../src/core/queue.ts';
test('concurrent contact mutations persist both contacts in submission order',async()=>{const queue=new MutationQueue();let contacts:string[]=[];const written:string[][]=[];const add=(call:string)=>queue.run(async()=>{const next=[call,...contacts];await new Promise(resolve=>setTimeout(resolve,3));written.push(next);contacts=next;});await Promise.all([add('K1ABC'),add('W9ABC')]);assert.deepEqual(contacts,['W9ABC','K1ABC']);assert.deepEqual(written,[['K1ABC'],['W9ABC','K1ABC']]);});
test('failed persistence does not prevent later serialized mutations',async()=>{const queue=new MutationQueue();await assert.rejects(queue.run(async()=>{throw new Error('quota');}));assert.equal(await queue.run(async()=>42),42);});
