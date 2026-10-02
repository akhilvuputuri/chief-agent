#include <node_api.h>
#include <sys/prctl.h>

/* Linux process boundary for the immutable worker. Same-UID repository commands
 * must not inspect its initial environment, memory or descriptors through /proc.
 * SIGUSR1 inspector activation is separately disabled by the trusted launcher. */
static napi_value lockdown(napi_env env, napi_callback_info info) {
  (void)info;
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) {
    napi_throw_error(env, "CODING_PROCESS_BOUNDARY", "Worker process isolation failed");
    return NULL;
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "lockdown", NAPI_AUTO_LENGTH, lockdown, NULL, &function);
  napi_set_named_property(env, exports, "lockdown", function);
  return exports;
}
NAPI_MODULE(secure_process, init)
