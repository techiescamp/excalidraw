import {ZxcvbnFactory} from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as english from '@zxcvbn-ts/language-en';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fail } from './core.js';
export const PASSWORD_GUIDANCE = 'Use 15–128 characters. Spaces and Unicode are welcome. Avoid common or compromised passwords.';
const strength = new ZxcvbnFactory({dictionary:{...common.dictionary,...english.dictionary},graphs:common.adjacencyGraphs,translations:english.translations});
const blocked = new Set(['passwordpassword','passwordpasswordpassword','123456789012345','1234567890123456','qwertyuiopasdfgh','thisisapassword','thisisapassword123','correct horse battery staple']);
// Optional offline SHA-1 corpus, one hexadecimal hash per line; no passwords leave the host.
const corpus = new Set(process.env.PASSWORD_BLOCKLIST_FILE ? readFileSync(process.env.PASSWORD_BLOCKLIST_FILE,'utf8').split(/\r?\n/).map(s=>s.split(':')[0].toUpperCase()) : []);
export function validatePassword(value) {
 if(typeof value !== 'string' || [...value].length < 15 || [...value].length > 128) fail(400,PASSWORD_GUIDANCE);
 if(strength.check(value).score < 2 || blocked.has(value.toLowerCase()) || /^(.)\1+$/u.test(value) || corpus.has(createHash('sha1').update(value).digest('hex').toUpperCase())) fail(400,'Choose a password that is not common or compromised.');
}
export const hashPassword = value => { validatePassword(value); return argon2.hash(value,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:4}); };
export const verifyPassword = async (hash, value) => typeof value === 'string' && [...value].length <= 128 && Boolean(hash) && await argon2.verify(hash,value);
