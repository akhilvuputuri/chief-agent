#define _GNU_SOURCE
#include <node_api.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static napi_value lockdown(napi_env env, napi_callback_info info) {
  (void)info;
  if(prctl(PR_SET_DUMPABLE,0,0,0,0)||prctl(PR_SET_CHILD_SUBREAPER,1,0,0,0)) {
    napi_throw_error(env,"ISOLATION_FAILED","Linux process boundary unavailable");return NULL;
  }
  napi_value result;napi_get_boolean(env,true,&result);return result;
}
/*
 * Kills and reaps the worker's children that descend from commands (journal 199). Every
 * command starts in a session of its own (Node's detached spawn calls setsid) and no process
 * can join another session, so a child of the worker whose session differs from the worker's
 * descends from a command: a daemon adopted by this subreaper. The worker's own children
 * (git, rg) share its session and are never touched, and each pid is reaped by its own number,
 * never with waitpid(-1). The executor calls this only when no command is running, so every
 * command shell has already been reaped by Node: nothing reaped here is a child Node waits for.
 * A pid stays ours until we reap it, so it cannot be reused between getsid and kill.
 *
 * Each pass kills every command descendant now listed as the worker's child and then waits until
 * each one is reaped (journal 200). SIGKILL cannot be caught or ignored, so each will die; the
 * kernel frees its memory before it can be reaped, about 63 ms per GiB measured, which is why a
 * fixed window of a few milliseconds was not enough. A dying process's own children are
 * re-parented to this subreaper before it can be reaped, so the next pass, which reads the list
 * again, sees them: a pass is a generation of descendants, not a unit of time. The wait blocks
 * the worker's event loop for that long (about one second for a box's whole memory); a process
 * that cannot die (stuck in uninterruptible I/O) blocks it until the host declares the worker's
 * heartbeat lost and ends the box (journal 200).
 */
static int foreign(pid_t pid,pid_t own) {pid_t sid=getsid(pid);return sid>=0&&sid!=own;}
/* ECHILD means it is no longer our child to wait for: nothing of it remains to reap here. */
static void reap(pid_t pid) {while(waitpid(pid,NULL,0)<0&&errno==EINTR) {}}
/* "pid (comm) state", from /proc/<pid>/stat; comm lies between the first '(' and the last ')'.
 * Never the command line: it can carry what the command was given. */
static void describe(pid_t pid,char *out,size_t size) {
  char path[64],line[512];snprintf(path,sizeof(path),"/proc/%d/stat",pid);
  FILE *f=fopen(path,"r");size_t n=f?fread(line,1,sizeof(line)-1,f):0;if(f)fclose(f);line[n]=0;
  char *open=strchr(line,'('),*close=strrchr(line,')');
  if(!open||!close||close<open||close[1]!=' '||!close[2]) {snprintf(out,size,"%d (unreadable)",pid);return;}
  *close=0;
  for(char *c=open+1;*c;c++) if(*c<0x20||*c>0x7e) *c='?';
  snprintf(out,size,"%d (%s) %c",pid,open+1,close[2]);
}
/* Bounds only a tree that forks new generations faster than they are killed: it then fails
 * loudly below instead of looping. No real command's descendants are this many generations deep. */
#define GENERATIONS 100
#define NAMED 4
static napi_value cleanup(napi_env env,napi_callback_info info) {
  (void)info;
  pid_t own=getsid(0);
  char path[128];snprintf(path,sizeof(path),"/proc/%d/task/%d/children",getpid(),getpid());
  pid_t *killed=NULL;size_t capacity=0;
  for(int pass=0;pass<GENERATIONS;pass++) {
    FILE *f=fopen(path,"r");int pid;size_t count=0;
    /* A guard that could not look must not report that nothing remains. */
    if(!f) {free(killed);napi_throw_error(env,"CLEANUP_FAILED","Cannot list the worker's children");return NULL;}
    /* Kill them all first, so the kernel frees their memory at once, then wait for each. */
    while(fscanf(f,"%d",&pid)==1) {
      if(!foreign(pid,own)) continue;
      if(count==capacity) {
        size_t next=capacity?capacity*2:64;pid_t *grown=realloc(killed,next*sizeof(pid_t));
        if(!grown) {kill(pid,SIGKILL);reap(pid);continue;}
        killed=grown;capacity=next;
      }
      kill(pid,SIGKILL);killed[count++]=pid;
    }
    fclose(f);
    for(size_t i=0;i<count;i++) reap(killed[i]);
    if(!count) break;
  }
  free(killed);
  FILE *remaining=fopen(path,"r");int pid,survivors=0;
  if(!remaining) {napi_throw_error(env,"CLEANUP_FAILED","Cannot list the worker's children");return NULL;}
  char message[512]="Command descendants remain:";size_t used=strlen(message);
  while(fscanf(remaining,"%d",&pid)==1) {
    if(!foreign(pid,own)) continue;
    if(survivors++<NAMED) {
      char one[64];describe(pid,one,sizeof(one));
      /* At most 4 x 64 characters: the message cannot fill; clamped all the same. */
      used+=snprintf(message+used,sizeof(message)-used,"%s %s",survivors>1?",":"",one);
      if(used>=sizeof(message)) used=sizeof(message)-1;
    }
  }
  fclose(remaining);
  if(survivors>NAMED) snprintf(message+used,sizeof(message)-used,", and %d more",survivors-NAMED);
  if(survivors) {napi_throw_error(env,"CLEANUP_FAILED",message);return NULL;}
  napi_value result;napi_get_boolean(env,true,&result);return result;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value f;napi_create_function(env,"lockdown",NAPI_AUTO_LENGTH,lockdown,NULL,&f);napi_set_named_property(env,exports,"lockdown",f);
  napi_create_function(env,"cleanup",NAPI_AUTO_LENGTH,cleanup,NULL,&f);napi_set_named_property(env,exports,"cleanup",f);return exports;
}
NAPI_MODULE(process_boundary,init)
