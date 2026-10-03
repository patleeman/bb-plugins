# Actual Dot transport proof

Verified on 3 October 2026 against the installed ChatGPT desktop app and the user's existing Dot. This is an investigation, not a shipped BB provider.

## Verified behavior

- Existing `~/.codex/auth.json` credentials authenticated the API requests. Credentials remained local and were not copied into the probe files.
- A message submitted directly to the Dot's messaging room returned HTTP 200. The Dot replied with the exact random token. The reply's account-user ID matched the room member whose `aeon_id` matched the Dot profile.
- A follow-up message asked for the previous token without including it. The Dot returned the same token. The request used `reply_to.message_id` to refer to the Dot's first response.
- The cloud app-server WebSocket accepted `initialize` followed by `initialized` and `thread/resume` with the existing root thread ID and `excludeTurns: true`.
- Live notifications included `turn/started`, `item/started`, `item/completed`, token usage, and `turn/completed`.
- For cancellation, the root was confirmed idle before sending a test. Its unique marker was observed in the live stream. `turn/interrupt` targeted that active root thread and turn ID, was accepted, and the same turn completed with status `interrupted`.
- The Dot remains unpaused. No BB provider, app configuration, permissions, or repository files were changed.

## Routes and request shapes

Base: `https://chatgpt.com/backend-api`

- `GET /tbo/primary`: select the account's Dot.
- `GET /tbo/by-thread/{root_thread_id}`: obtain the Dot profile, `messaging_room_id`, and `active_root_thread_id`.
- `GET /messaging/rooms/{room_id}`: verify Dot membership and sender identity.
- `POST /messaging/rooms/{room_id}/messages`: submit a message.
- `GET /messaging/rooms/{room_id}/messages?limit=…`: read delivered messages.
- `POST /messaging/rooms/{room_id}/live`: verified SSE subscription-ready response; message/status event delivery on this endpoint was not established.

Message body:

```json
{
  "content": {"text": "…"},
  "request_id": "<UUID>",
  "idempotency_token": "<same UUID>",
  "reply_to": {"message_id": "<optional previous message ID>"}
}
```

Cloud WebSocket: `wss://codex-cloud-backend.chatgpt.com/`

Observed subprotocols: `codex-app-server`, `codex-client.desktop`, and `openai-bearer.<access token>`. Never log the last subprotocol.

After initialization:

```json
{"id":2,"method":"thread/resume","params":{"threadId":"<Dot root>","excludeTurns":true}}
{"id":3,"method":"turn/interrupt","params":{"threadId":"<Dot root>","turnId":"<verified test turn>"}}
```

HTTP history is also available at `https://codex-cloud-backend.chatgpt.com/v1/threads/{root}/turns`, with `X-OpenAI-Product-Sku: aeon`. A completed message-admission turn is distinct from its response turn; do not infer a cancellation target from that admission turn alone.

## Implications for a BB provider

Use the messaging API for Dot input and delivered answers; use the cloud WebSocket for live execution events and targeted interrupts. Maintain request/message/turn IDs and distinguish other Dot activity from a BB request. The Dot is one existing persistent agent, so BB threads do not automatically become isolated Dot conversations. Handle root changes, multiple clients, reconnects, token refresh, and uncertain delivery before production use.

Token-by-token answer streaming, direct dynamic-tool injection, skill loading, per-BB-thread isolation, cost/budget enforcement, and reliable concurrent request correlation are not established by this proof. Native BB tools and skills still require a separate supported integration or verified cloud configuration API. Private routes may change.

## Preserved minimal probes

These probes are reference material, not production provider code. Private
routes may change. The examples contain no account, room, or thread IDs and
no credentials. Keep discovery/results local with mode 0600. The cancellation
probe sends a test message and must only interrupt its own correlated turn.
`client.py` writes discovery for the subsequent WebSocket probes.

### client.py

```python
import json
from pathlib import Path
import urllib.request
import urllib.error

BASE = 'https://chatgpt.com/backend-api'

def request(path, body=None):
    auth = json.loads((Path.home()/'.codex/auth.json').read_text())['tokens']
    headers = {'Authorization': 'Bearer ' + auth['access_token'], 'ChatGPT-Account-Id': auth['account_id'], 'Accept': 'application/json', 'User-Agent': 'codex-cli/0.159.0', 'Content-Type': 'application/json'}
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            result = json.loads(raw)
        except ValueError:
            result = {'non_json': True, 'challenge': b'Just a moment' in raw or b'cf-chl' in raw}
        return error.code, result

if __name__ == '__main__':
    for path in ['/tbo/primary']:
        status, data = request(path)
        print(json.dumps({'path': path, 'status': status, 'keys': list(data) if isinstance(data, dict) else None, 'error': data if status != 200 else None}))
        if status == 200:
            Path('/tmp/bb-dot-transport/discovery.json').write_text(json.dumps(data))
            Path('/tmp/bb-dot-transport/discovery.json').chmod(0o600)

```

### resume-test.mjs

```javascript
import fs from 'node:fs';
import os from 'node:os';
const auth = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, 'utf8')).tokens;
const profile = JSON.parse(fs.readFileSync('/tmp/bb-dot-transport/discovery.json', 'utf8'));
const ws = new WebSocket('wss://codex-cloud-backend.chatgpt.com/', ['codex-app-server', 'codex-client.desktop', `openai-bearer.${auth.access_token}`]);
const deadline = setTimeout(() => { console.log('socket deadline'); ws.close(); }, 20000);
let initialized = false;
ws.addEventListener('open', () => {
  console.log('socket connected');
  ws.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'bb_dot_transport_probe',version:'0.1.0'},capabilities:{experimentalApi:true}}}));
});
ws.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (data.id === 1) {
    console.log(JSON.stringify({initialize: data.error ?? Object.keys(data.result ?? {})}));
    if (data.error) { ws.close(); return; }
    initialized = true;
    ws.send(JSON.stringify({method:'initialized'}));
    ws.send(JSON.stringify({id:2,method:'thread/resume',params:{threadId:profile.active_root_thread_id,excludeTurns:true}}));
  } else if (data.id === 2) {
    console.log(JSON.stringify({turns: data.error ?? data.result?.thread?.status ?? Object.keys(data.result ?? {})}));
    fs.writeFileSync('/tmp/bb-dot-transport/resume.json',JSON.stringify(data),{mode:0o600});
    ws.close();
  } else if (data.method) console.log('notification', data.method);
});
ws.addEventListener('error', () => { console.log('socket error'); ws.close(); });
ws.addEventListener('close', event => { clearTimeout(deadline); console.log(JSON.stringify({closed:event.code,initialized})); });

```

### stream-cancel.mjs

```javascript
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
const auth=JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`,'utf8')).tokens;
const profile=JSON.parse(fs.readFileSync('/tmp/bb-dot-transport/discovery.json','utf8'));
const state={marker:`BB-CANCEL-${crypto.randomUUID().slice(0,8)}`,requestId:crypto.randomUUID(),events:{}};
const save=()=>fs.writeFileSync('/tmp/bb-dot-transport/stream-cancellation.json',JSON.stringify(state),{mode:0o600});
async function http(url, body) {
 const current = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, 'utf8')).tokens;
 const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${current.access_token}`, 'ChatGPT-Account-Id': current.account_id,
   'Content-Type': 'application/json', 'User-Agent': 'codex-cli/0.159.0' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 if (!response.ok) throw Error(`HTTP ${response.status}`);
 return response.json();
}
const ws=new WebSocket('wss://codex-cloud-backend.chatgpt.com/',['codex-app-server','codex-client.desktop',`openai-bearer.${auth.access_token}`]);
const pending=new Map();let id=0,activeTurn=null,ownMarker=false,interrupting=false,afterSend=false;
function rpc(method,params){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error(`deadline ${method}`));},10000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});}
async function interruptIfOwned(){
 if(!ownMarker||!activeTurn||interrupting||!afterSend)return;
 interrupting=true;state.targetTurnId=activeTurn;save();
 try{state.interruptResult=await rpc('turn/interrupt',{threadId:profile.active_root_thread_id,turnId:activeTurn});state.interruptAccepted=true;console.log('interrupt accepted',state.targetTurnId);}catch(e){state.interruptError=e.message;console.log('interrupt failed',e.message);}
 save();
}
ws.addEventListener('message',event=>{
 const d=JSON.parse(event.data),h=pending.get(d.id);
 if(h){pending.delete(d.id);clearTimeout(h.timer);d.error?h.reject(Error(JSON.stringify(d.error))):h.resolve(d.result);return;}
 if(!d.method||d.params?.threadId&&d.params.threadId!==profile.active_root_thread_id)return;
 state.events[d.method]=(state.events[d.method]??0)+1;
 const p=d.params??{};
 if(d.method==='turn/started'){activeTurn=p.turn?.id??p.turnId;console.log('turn started',activeTurn);if(ownMarker)setTimeout(interruptIfOwned,0);}
 if(d.method==='turn/completed'){console.log('turn completed',p.turn?.id,p.turn?.status);if(p.turn?.id===state.targetTurnId){state.finalStatus=p.turn.status;save();ws.close();}if(p.turn?.id===activeTurn)activeTurn=null;}
 if(JSON.stringify(p).includes(state.marker)){ownMarker=true;state.markerObservedInStream=true;console.log('own marker observed',d.method);setTimeout(interruptIfOwned,200);}
 if(d.method.includes('Delta'))state.deltaObserved=true;
 save();
});
const deadline=setTimeout(()=>{state.deadline=true;save();ws.close();},40000);
ws.addEventListener('close',()=>{clearTimeout(deadline);save();setTimeout(()=>process.exit(0),100);});
try{
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('connect deadline')),10000);ws.addEventListener('open',()=>{clearTimeout(t);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(t);reject(Error('socket error'));},{once:true});});
 await rpc('initialize',{clientInfo:{name:'bb_dot_transport_probe',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized'}));
 const r=await rpc('thread/resume',{threadId:profile.active_root_thread_id,excludeTurns:true});state.initialStatus=r.thread.status;
 if(r.thread.status.type!=='idle')throw Error('Dot root is busy; test not sent');
 save();afterSend=true;
 const m=await http(`https://chatgpt.com/backend-api/messaging/rooms/${profile.messaging_room_id}/messages`,{content:{text:`Cancellation probe ${state.marker}. Reply with integers 1 through 1000, one per line. Use no tools except reply delivery; create no tasks and change no files. The user authorized interruption of this probe.`},request_id:state.requestId,idempotency_token:state.requestId});state.messageId=m.id;save();console.log('probe accepted; watching live turn');
}catch(e){state.error=e.message;save();console.log('error',e.message);ws.close();}

```


## Provider implementation observations

Read-only checks on 3 October 2026 verified that `/tbo/primary` wraps the
selection and profile in `{selection, profile}`. Resolve `selection.thread_id`
through `/tbo/by-thread/{root}` before using the active root and room. Native
Node HTTPS succeeds for discovery; Node `fetch` returned HTTP 403 in the same
environment. The provider client uses native HTTPS with bounded responses.

The first proof reply has neither `request_id` nor `reply_to`. The continuation
reply does contain `reply_to.message_id` equal to its incoming message ID.
Sender identity alone is insufficient correlation: the implementation accepts
only the verified Dot member plus an exact request ID or direct reply reference.
Unlinked messages must not be assigned to the next BB turn.

Authentication refresh delegates to Codex `app-server` via `account/read` with
`refreshToken: true`, using its existing local auth storage. See the upstream
[GetAccountParams schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/GetAccountParams.json).
The client rereads credentials before each HTTP request, retries a 401 once, and
uses any externally rotated token before requesting another refresh.

`BB_DOT_LIVE_READONLY=1 npm test -- src/dot-client.test.ts` passed discovery
and six fixture tests without submitting a message. This is transport evidence;
the Dot BB bridge, cross-process queue, stream recovery, and staged prompt/cancel
checks are still pending. Dot remains unregistered and disabled.

The subsequently approved best-effort fallback is documented in the provider
README. It combines one in-flight BB request per Dot, verified member identity,
server timestamps, and a cloud turn boundary; concurrent messages from another
client require an uncertainty note. That fallback is not yet implemented and
does not change the observations above about missing correlation fields.


## Registered provider

The experimental provider is now registered when `dotEnabled=true` (default
false). Its BB bridge implements the documented best-effort fallback, tools
and assistant stream events, the cross-process room queue, and cloud interrupt.
History requests use the observed maximum `limit=32` and accept null text on
non-text messages. The staged token round trip and cloud-confirmed interruption
have passed. Earlier implementation-status paragraphs above describe milestones,
not the final state.
