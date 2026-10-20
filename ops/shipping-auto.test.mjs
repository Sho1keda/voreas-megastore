import assert from 'node:assert/strict';
import worker from '../_worker.js';
import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;
const notifications = new Map(), exclusions = new Set(['old']), observations = new Map();
let seeded = 185, dbFail = false;
const DB = {prepare(sql) { return {args:[], bind(...a){this.args=a;return this;}, async first(){
  if(dbFail) throw Error('DB down');
  if(sql.includes('COUNT(*)')) return {count:seeded};
  if(sql.includes('shipping_exclusions')) return exclusions.has(this.args[0])?{reason:'already delivered'}:null;
  return notifications.get(this.args[0]);
}, async all(){return {results:sql.includes('shipping_exclusions')?[...exclusions].map(order_id=>({order_id})):sql.includes('shipping_observations')?[...observations.values()]:[...notifications.values()]};}, async run(){
  if(dbFail) throw Error('DB down');const a=this.args;
  if(sql.startsWith('INSERT INTO shipping_observations')){observations.set(a[0],{event_id:a[0],order_id:a[1],outcome:a[2],detail:a[3]});return {meta:{changes:1}};}
  if(sql.startsWith('INSERT OR IGNORE INTO shipping_notifications')){if(notifications.has(a[0])||exclusions.has(a[6]))return {meta:{changes:0}};notifications.set(a[0],{order_id:a[0],status:a[2]});return {meta:{changes:1}};}
  if(sql.startsWith('UPDATE shipping_notifications')){notifications.set(a[3],{order_id:a[3],status:a[0],resend_id:a[1]});return {meta:{changes:1}};}
  throw Error('Unexpected SQL '+sql);
}};}};
const order = (id='new') => ({id,location_id:'WMTQJASMPBH13',source:{name:'voreas-ec'},state:'COMPLETED',fulfillments:[{uid:'f',type:'SHIPMENT',state:'COMPLETED',shipment_details:{shipped_at:'2026-10-21T00:00:00Z',carrier:'ヤマト運輸',tracking_number:'4725-9926‐4163',recipient:{email_address:'customer@example.com',display_name:'test'}}}]});
let current=order(), sends=[], reads=0, provider='ok', squareFail=false;
globalThis.fetch=async(url,opts)=>{
  if(String(url).endsWith('/orders/search'))return Response.json({orders:[current]});
  if(String(url).includes('/v2/orders/')){reads++;if(squareFail)throw Error('unavailable');return Response.json({order:current});}
  if(url==='https://api.resend.com/emails'){assert.equal(notifications.get(current.id)?.status,'pending','claim exists BEFORE provider');sends.push({body:JSON.parse(opts.body),key:opts.headers['Idempotency-Key']});if(provider==='timeout')throw Error('timeout');if(provider==='reject')return Response.json({error:'rate limit'},{status:429});return Response.json({id:'sent-id'});}
  throw Error('Unexpected fetch '+url);
};
const env={SHIPPING_AUTO_ENABLED:'true',SHIPPING_AUTO_START_AT:'2026-10-20T12:00:00Z',SHIPPING_DB:DB,SQUARE_WEBHOOK_SIGNATURE_KEY:'signkey',SQUARE_ACCESS_TOKEN:'square',RESEND_API_KEY:'resend',SHIPPING_ADMIN_TOKEN:'admin'};
let eventNum=0,n=0;
const check=(value,label)=>{assert.ok(value,label);console.log(`PASS ${++n} ${label}`);};
async function call(id=current.id, overrides={}, sig='valid', extra={}){
  const body=JSON.stringify({event_id:`e${++eventNum}`,type:'order.updated',data:{object:{order_updated:{order_id:id}}},...extra});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('signkey'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const hmac=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('https://voreas-megastore.pages.dev/api/webhooks/square'+body))).toString('base64');
  const headers=sig==='missing'?{}:{'x-square-hmacsha256-signature':sig==='valid'?hmac:sig};
  const r=await worker.fetch(new Request('https://internal/api/webhooks/square',{method:'POST',headers,body}),{...env,...overrides},{});
  return {status:r.status,body:await r.json()};
}
check((await call('new',{},'bad')).status===401&&reads===0,'bad signature rejected before read');
check((await call('new',{},'missing')).status===401,'missing signature rejected');
check((await call('new',{SQUARE_WEBHOOK_SIGNATURE_KEY:undefined})).status===503,'missing verification key fails closed');
check((await call('old')).body.shipping==='excluded_permanently'&&sends.length===0&&reads===0,'old order excluded before read or send');
check((await call('new',{SHIPPING_AUTO_ENABLED:'false'})).body.shipping==='disabled','OFF records event without reading or sending');
seeded=184;check((await call()).status===503&&sends.length===0,'incomplete exclusion seed fails closed');seeded=185;
check((await call('new',{SHIPPING_AUTO_START_AT:''})).status===503,'missing cutover fails closed');
check((await call('new',{},'valid',{data:{object:{order:{id:'new'}}}})).status===400,'full-order assumed payload rejected');
current.source.name='other';check((await call()).body.shipping==='not_eligible','foreign source rejected');current=order();
current.location_id='other';check((await call()).body.shipping==='not_eligible','foreign location rejected');current=order();
current.state='CANCELED';check((await call()).body.shipping==='not_eligible','canceled order rejected');current=order();
current.fulfillments[0].state='PREPARED';check((await call()).body.shipping==='not_ready','not completed does not send');current=order();
delete current.fulfillments[0].shipment_details.tracking_number;check((await call()).body.shipping==='not_ready','no tracking does not send');current=order();
current.fulfillments[0].shipment_details.shipped_at='2026-10-19T00:00:00Z';check((await call()).body.shipping==='held','pre-cutover shipment held');current=order();
delete current.fulfillments[0].shipment_details.shipped_at;check((await call()).body.shipping==='held','missing shipped_at held');current=order();
current.fulfillments.push({...current.fulfillments[0],uid:'f2',state:'PREPARED'});check((await call()).body.shipping==='held','multiple shipments including incomplete held');current=order();
delete current.fulfillments[0].shipment_details.recipient.email_address;check((await call()).body.shipping==='held','missing email held without guessing');current=order();
current.fulfillments[0].shipment_details.carrier='unknown';check((await call()).body.shipping==='held','unknown carrier held');current=order();
current.fulfillments[0].shipment_details.tracking_number='garbage';check((await call()).body.shipping==='held','invalid tracking held');current=order();
check((await call()).body.shipping==='sent'&&sends.length===1,'eligible current order sent');
check(sends[0].body.text.includes('472599264163')&&sends[0].body.text.includes('https://toi.kuronekoyamato.co.jp/')&&sends[0].body.to==='customer@example.com','actual tracking and carrier URL sent to recipient');
await call();check(sends.length===1,'duplicate webhook with different event id deduplicated');
current=order('parallel');await Promise.all([call(),call()]);check(sends.length===2,'concurrent deliveries one provider call');
current=order('unknown');provider='timeout';check((await call()).body.shipping==='unknown','provider timeout preserved');await call();check(sends.length===3,'unknown never resent');
current=order('reject');provider='reject';check((await call()).body.shipping==='provider_error','rejection preserved');await call();check(sends.length===4,'rejection never retried');provider='ok';
current=order('manual');notifications.set('manual',{order_id:'manual',status:'pending'});await call();check(sends.length===4,'manual API claim blocks automatic send');
current=order('readfail');squareFail=true;check((await call()).status===503&&!notifications.has('readfail'),'Square failure before claim retryable');squareFail=false;
dbFail=true;check((await call()).status===503&&sends.length===4,'DB failure never sends');dbFail=false;
const refund={type:'refund.created',data:{object:{refund:{payment_id:'p',status:'COMPLETED'}}}};
check((await call('x',{},'valid',refund)).body.action==='refund','valid signed existing refund route preserved');
check((await call('x',{},'bad',refund)).status===401,'forged refund blocked');
check([...observations.values()].some(r=>r.detail==='carrier_confirmation_required'),'held reasons durably visible');
const dry=await worker.fetch(new Request('https://internal/api/manage/notify-shipped',{method:'POST',headers:{Authorization:'Bearer admin'},body:'{"mode":"dry-run"}'}),env,{});
const manifest=await dry.json();check(manifest.unnotified.some(r=>r.orderId==='readfail')&&manifest.exclusions.length===1&&manifest.observations.length>0,'dry-run exposes unnotified, exclusions and observations');
current=order('old');
const admin=async(body,overrides={})=>{const r=await worker.fetch(new Request('https://internal/api/manage/notify-shipped',{method:'POST',headers:{Authorization:'Bearer admin'},body:JSON.stringify(body)}),{...env,...overrides},{});return {status:r.status,body:await r.json()};};
const oldManifest=(await admin({mode:'dry-run'})).body;
notifications.set(`TEST:${oldManifest.hash}`,{order_id:`TEST:${oldManifest.hash}`,status:'sent'});
const oldSend=await admin({mode:'send',manifestHash:oldManifest.hash,orderIds:['old']},{SHIPPING_APPROVED_MANIFEST:oldManifest.hash});
check(oldSend.body.attempted===0&&sends.length===4&&!notifications.has('old'),'approved manual recovery cannot send excluded legacy order');
seeded=0;check((await admin({mode:'send',manifestHash:oldManifest.hash},{SHIPPING_APPROVED_MANIFEST:oldManifest.hash})).status===503,'manual send also requires exclusion seed');seeded=185;
console.log(`ALL ${n} AUTO SHIPPING CHECKS PASSED`);
