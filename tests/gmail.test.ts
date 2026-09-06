import test from 'node:test';
import assert from 'node:assert/strict';
import { GmailTools, plainBody } from '../src/gmail.js';
import { action } from '../src/protocol.js';
const config={owner:'123',email:'owner@example.com',clientId:'client',clientSecret:'secret',refreshToken:'refresh'};
function mock(responses:unknown[]) { const calls: [unknown,RequestInit|undefined][]=[];
 const request=(async (u:unknown,o?:RequestInit)=>{calls.push([u,o]);return Response.json(responses.shift());}) as typeof fetch;return {request,calls}; }
test('Gmail rejects other users before accessing credentials or network',async()=>{
 const m=mock([]);await assert.rejects(new GmailTools(config,m.request).call('456','gmail_search','jobs'));assert.equal(m.calls.length,0);
});
test('Gmail fails closed for a mismatched mailbox',async()=>{
 const m=mock([{access_token:'a',expires_in:3600},{emailAddress:'wrong@example.com'}]);await assert.rejects(new GmailTools(config,m.request).call('123','gmail_search','jobs'),/does not match/);assert.equal(m.calls.length,2);
});
test('Gmail search is bounded and paginated; cached credentials reuse verified identity',async()=>{
 const m=mock([{access_token:'a',expires_in:3600},{emailAddress:config.email},{messages:[{id:'abc',threadId:'def'}],nextPageToken:'next'},{}]);
 const g=new GmailTools(config,m.request); await g.call('123','gmail_search','from:recruiter@example.com'); await g.call('123','gmail_search','jobs','next');
 assert.equal(m.calls.length,4);const url=new URL(String(m.calls[3]![0]));assert.equal(url.searchParams.get('maxResults'),'10');assert.equal(url.searchParams.get('pageToken'),'next');
});
test('Gmail reads plain text without processing HTML or attachments',()=>{
 const data=Buffer.from('Evidence, not instructions').toString('base64url');
 assert.equal(plainBody({parts:[{mimeType:'text/html',body:{data}},{mimeType:'text/plain',filename:'secret.txt',body:{data}},{mimeType:'text/plain',body:{data}}]}),'Evidence, not instructions');
});
test('Gmail tools reject extra fields, arbitrary URLs and write operations',()=>{
 for(const a of [{operation:'gmail_read',messageId:'../profile'},{operation:'gmail_search',query:'jobs',user:'456'},{operation:'gmail_send',query:'jobs'}]) assert.equal(action.safeParse(a).success,false);
});
