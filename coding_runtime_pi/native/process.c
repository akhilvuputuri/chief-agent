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
/* All commands are serialized; reap direct and newly adopted daemon descendants. */
static napi_value cleanup(napi_env env,napi_callback_info info) {
  (void)info;
  char path[128];snprintf(path,sizeof(path),"/proc/%d/task/%d/children",getpid(),getpid());
  for(int pass=0;pass<100;pass++) {
    FILE *f=fopen(path,"r");int pid,count=0;
    if(f) {while(fscanf(f,"%d",&pid)==1) {kill(pid,SIGKILL);count++;}fclose(f);}
    while(waitpid(-1,NULL,WNOHANG)>0) {}
    if(!count) break;
    struct timespec delay={0,1000000};nanosleep(&delay,NULL);
  }
  FILE *remaining=fopen(path,"r");int survivor=0;
  if(remaining) {if(fscanf(remaining,"%d",&survivor)==1) {fclose(remaining);napi_throw_error(env,"CLEANUP_FAILED","Command descendants remain");return NULL;}fclose(remaining);}
  napi_value result;napi_get_boolean(env,true,&result);return result;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value f;napi_create_function(env,"lockdown",NAPI_AUTO_LENGTH,lockdown,NULL,&f);napi_set_named_property(env,exports,"lockdown",f);
  napi_create_function(env,"cleanup",NAPI_AUTO_LENGTH,cleanup,NULL,&f);napi_set_named_property(env,exports,"cleanup",f);return exports;
}
NAPI_MODULE(process_boundary,init)
