# Browser confinement

Seccomp profile is the official Playwright crawler profile from immutable microsoft/playwright commit `7ad3fba1aad9471c7e46d67a11b0e710a5d77ea8` (`utils/docker/seccomp_profile.json`), based on Docker default with user namespace support. It is reviewed alongside this application change; no unconfined or privileged browser fallback is permitted.
