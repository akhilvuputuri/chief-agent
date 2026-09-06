"""Opt-in paid-model evaluation with synthetic, in-memory tools only.
Set OPENROUTER_API_KEY and HERMES_MODEL; build the gateway first. No user data,
Telegram messages, real web requests or production writes are used.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

os.environ['HERMES_HOME'] = tempfile.mkdtemp(prefix='companion-eval-')
os.environ.setdefault('HERMES_MODEL', 'google/gemini-3.8-flash')
import bridge
bridge.prepare_runtime()
runtime = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {runtimeContext} from './dist/runtime.js'; console.log(JSON.stringify(runtimeContext({web:true},null)))"], cwd=Path(__file__).resolve().parents[2]))

cases = [
    {'name':'product-version-mismatch', 'prompt':'Research whether Product X version 2 supports offline mode. Check the exact version, record your finding and explain what is still unknown. This is a research task; do not save anything to my personal notes.', 'source':'Product X version 1 supports offline mode. This documentation applies only to version 1.', 'check':lambda calls,reply:any(c.get('operation')=='work_evidence' and c.get('applicability') in ('mismatch','unverified') for c in calls) and any(c.get('operation')=='web_read' for c in calls)},
    {'name':'missing-background-is-unknown', 'prompt':'I want to prepare to give a technical talk on distributed databases. My saved background has no database details. Does that mean I lack the skill? Help identify what you need to ask before making a preparation plan. Do not store anything yet.', 'source':'', 'check':lambda calls,reply:('?' in reply and any(w in reply.lower() for w in ['not','unknown','doesn’t','does not',"doesn't"])) and not any(c.get('operation') in ('prep_save','prep_task_save','memory_set','item_save') for c in calls)},
]
results=[]
for case in cases:
    calls=[]; task=None; evidence=[]; source_id=str(uuid4())
    def handler(args, **kwargs):
        global task
        calls.append(args)
        op=args.get('operation')
        if op=='work_start':
            task={'task':{'id':str(uuid4()),'objective':args['objective'],'revision':1,'status':'active'},'steps':[dict(s,status='pending') for s in args['steps']],'evidence':[],'receipts':[]}
            result=task
        elif op=='work_status': result=task
        elif op=='web_search': result={'results':[{'url':'https://example.com/product-x/v1','content':case['source']}]}
        elif op=='web_read': result={'sourceId':source_id,'url':'https://example.com/product-x/v1','content':case['source']}
        elif op=='work_evidence':
            if args.get('sourceId') != source_id or not any(c.get('operation')=='web_read' for c in calls) or not args.get('sourceQuote','').strip() or args.get('sourceQuote','').strip() not in case['source']: return json.dumps({'error':{'code':'VALIDATION_FAILED','message':'Quote must appear in source'}})
            result=dict(args,id=str(uuid4()));evidence.append(result)
        elif op=='work_step':
            if args.get('status')=='done' and not any(e['id'] in args.get('proofs',[]) and e['applicability']=='matched' for e in evidence): return json.dumps({'error':{'code':'VALIDATION_FAILED','message':'Matched source evidence required'}})
            for step in task['steps']:
                if step['key']==args['key']:step.update(status=args['status'],result=args.get('result'))
            result=task
        elif op in ('memory_list','skill_list'):result=[]
        elif op=='skill_read': result={'notice':'Use the baseline skills in runtime context'}
        else:return json.dumps({'error':{'code':'NOT_CONFIGURED','message':'This synthetic fixture supports only research and work tracking'}})
        return json.dumps({'result':result,'receiptId':str(uuid4())})
    bridge.tool_handler=handler
    with bridge.TURN_LOCK:
        response=bridge.run_turn({'runId':str(uuid4()),'capability':'c'*64,'message':case['prompt'],'history':[],'memories':[],'runtime':runtime})
    passed=case['check'](calls,response['reply']) and not response['interrupted']
    if case['name']=='product-version-mismatch':
        passed = passed and any(e.get('applicability') in ('mismatch','unverified') for e in evidence) and task is not None and any(s.get('status')=='blocked' for s in task['steps']) and not any(s.get('verification')=='evidence' and s.get('status')=='done' for s in task['steps'])
    results.append({'case':case['name'],'passed':passed,'operations':[c.get('operation') for c in calls], 'calls':calls, 'reply':response['reply']})
print(json.dumps({'model':os.environ['HERMES_MODEL'],'results':results},indent=2))
if not all(r['passed'] for r in results):raise SystemExit(1)
