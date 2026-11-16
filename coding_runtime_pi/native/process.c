#define _GNU_SOURCE
#include <node_api.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>
#include <time.h>

static napi_value lockdown(napi_env env, napi_callback_info info) {
  (void)info;
  if(prctl(PR_SET_DUMPABLE,0,0,0,0)||prctl(PR_SET_CHILD_SUBREAPER,1,0,0,0)) {
    napi_throw_error(env,"ISOLATION_FAILED","Linux process boundary unavailable");return NULL;
  }
  napi_value result;napi_get_boolean(env,true,&result);return result;
}
/*
 * Kills and reaps the worker's children that descend from commands (journal 197). Every
 * command starts in a session of its own (Node's detached spawn calls setsid) and no process
 * can join another session, so a child of the worker whose session differs from the worker's
 * descends from a command: a daemon adopted by this subreaper. The worker's own children
 * (git, rg) share its session and are never touched, and each pid is reaped by its own number,
 * never with waitpid(-1). The executor calls this only when no command is running, so every
 * command shell has already been reaped by Node: nothing reaped here is a child Node waits for.
 * A pid stays ours until we reap it, so it cannot be reused between getsid and kill.
 */
static int foreign(pid_t pid,pid_t own) {pid_t sid=getsid(pid);return sid>=0&&sid!=own;}
static napi_value cleanup(napi_env env,napi_callback_info info) {
  (void)info;
  pid_t own=getsid(0);
  char path[128];snprintf(path,sizeof(path),"/proc/%d/task/%d/children",getpid(),getpid());
  for(int pass=0;pass<100;pass++) {
    FILE *f=fopen(path,"r");int pid,count=0;
    /* A guard that could not look must not report that nothing remains. */
    if(!f&&pass==0) {napi_throw_error(env,"CLEANUP_FAILED","Cannot list the worker's children");return NULL;}
    if(f) {while(fscanf(f,"%d",&pid)==1) {if(!foreign(pid,own)) continue;kill(pid,SIGKILL);waitpid(pid,NULL,WNOHANG);count++;}fclose(f);}
    if(!count) break;
    struct timespec delay={0,1000000};nanosleep(&delay,NULL);
  }
  FILE *remaining=fopen(path,"r");int pid,survivor=0;
  if(!remaining) {napi_throw_error(env,"CLEANUP_FAILED","Cannot list the worker's children");return NULL;}
  while(fscanf(remaining,"%d",&pid)==1) if(foreign(pid,own)) survivor=1;
  fclose(remaining);
  if(survivor) {napi_throw_error(env,"CLEANUP_FAILED","Command descendants remain");return NULL;}
  napi_value result;napi_get_boolean(env,true,&result);return result;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value f;napi_create_function(env,"lockdown",NAPI_AUTO_LENGTH,lockdown,NULL,&f);napi_set_named_property(env,exports,"lockdown",f);
  napi_create_function(env,"cleanup",NAPI_AUTO_LENGTH,cleanup,NULL,&f);napi_set_named_property(env,exports,"cleanup",f);return exports;
}
NAPI_MODULE(process_boundary,init)
