#define _GNU_SOURCE
#include <node_api.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
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
 * Each pass reads the list, SIGKILLs every command descendant on it and reaps whichever have
 * already exited, without blocking on any one of them; it ends when a pass lists none (journal
 * 200). A killed process's children are re-parented here before it can be reaped, so a later
 * pass lists and kills them while earlier ones are still dying. Blocking on one pid instead would
 * leave those later generations running for as long as that pid takes, and a traced zombie can
 * only be reaped once its tracer, possibly one of those later generations, has died.
 *
 * There is no time limit. SIGKILL cannot be caught or ignored, so every killed process dies; the
 * kernel frees its memory before it can be reaped, about 63 ms per GiB measured, and a process
 * stuck in uninterruptible I/O takes as long as that I/O. Meanwhile the worker's event loop is
 * blocked; if that lasts, the host declares the worker's heartbeat lost and ends the box
 * (journal 200). The only bound is on generations: a pass that lists a pid the previous pass did
 * not list counts as one, and passes that only wait for pids already killed do not. A tree that
 * keeps making new processes faster than they are killed fails loudly, naming what survives.
 */
static int foreign(pid_t pid,pid_t own) {pid_t sid=getsid(pid);return sid>=0&&sid!=own;}
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
typedef struct {pid_t *pids;size_t count,capacity;} pids_t;
static int add(pids_t *list,pid_t pid) {
  if(list->count==list->capacity) {
    size_t next=list->capacity?list->capacity*2:64;pid_t *grown=realloc(list->pids,next*sizeof(pid_t));
    if(!grown) return 0;
    list->pids=grown;list->capacity=next;
  }
  list->pids[list->count++]=pid;return 1;
}
static int order(const void *a,const void *b) {pid_t x=*(const pid_t *)a,y=*(const pid_t *)b;return (x>y)-(x<y);}
/* Generations of new processes, not passes or time: no real command's descendants come close. */
#define GENERATIONS 100
#define NAMED 4
static napi_value refuse(napi_env env,pids_t *a,pids_t *b,const char *message) {
  free(a->pids);free(b->pids);napi_throw_error(env,"CLEANUP_FAILED",message);return NULL;
}
static napi_value cleanup(napi_env env,napi_callback_info info) {
  (void)info;
  pid_t own=getsid(0);
  char path[128];snprintf(path,sizeof(path),"/proc/%d/task/%d/children",getpid(),getpid());
  pids_t seen={0},now={0};int generations=0;
  for(;;) {
    FILE *f=fopen(path,"r");int pid,fresh=0;
    /* A guard that could not look must not report that nothing remains. */
    if(!f) return refuse(env,&seen,&now,"Cannot list the worker's children");
    now.count=0;
    while(fscanf(f,"%d",&pid)==1) {
      if(!foreign(pid,own)) continue;
      kill(pid,SIGKILL);waitpid(pid,NULL,WNOHANG);
      /* Losing track would hide a new generation: fail loudly instead. */
      if(!add(&now,pid)) {fclose(f);return refuse(env,&seen,&now,"Cannot track the worker's children");}
      if(!seen.count||!bsearch(&pid,seen.pids,seen.count,sizeof(pid_t),order)) fresh=1;
    }
    fclose(f);
    if(!now.count) break;
    if(fresh&&++generations>GENERATIONS) {
      char message[512]="Command descendants remain:";size_t used=strlen(message);
      for(size_t i=0;i<now.count&&i<NAMED;i++) {
        char one[64];describe(now.pids[i],one,sizeof(one));
        /* At most 4 x 64 characters: the message cannot fill; clamped all the same. */
        used+=snprintf(message+used,sizeof(message)-used,"%s %s",i?",":"",one);
        if(used>=sizeof(message)) used=sizeof(message)-1;
      }
      if(now.count>NAMED) snprintf(message+used,sizeof(message)-used,", and %zu more",now.count-NAMED);
      return refuse(env,&seen,&now,message);
    }
    qsort(now.pids,now.count,sizeof(pid_t),order);
    pids_t swap=seen;seen=now;now=swap;
    struct timespec delay={0,1000000};nanosleep(&delay,NULL);
  }
  free(seen.pids);free(now.pids);
  napi_value result;napi_get_boolean(env,true,&result);return result;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value f;napi_create_function(env,"lockdown",NAPI_AUTO_LENGTH,lockdown,NULL,&f);napi_set_named_property(env,exports,"lockdown",f);
  napi_create_function(env,"cleanup",NAPI_AUTO_LENGTH,cleanup,NULL,&f);napi_set_named_property(env,exports,"cleanup",f);return exports;
}
NAPI_MODULE(process_boundary,init)
