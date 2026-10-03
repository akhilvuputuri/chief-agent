# Browser confinement

Seccomp profile is the official Playwright crawler profile from immutable microsoft/playwright commit `7ad3fba1aad9471c7e46d67a11b0e710a5d77ea8` (`utils/docker/seccomp_profile.json`), based on Docker default with user namespace support. It is reviewed alongside this application change; no unconfined or privileged browser fallback is permitted.

The host proof reached Chromium's namespace sandbox under existing Docker/AppArmor restrictions, so no AppArmor policy change is needed. With all host capabilities dropped, the default conditional `chroot` seccomp permission was unavailable. The browser-only profile permits the syscall for Chromium's internal user-namespace sandbox; kernel capability checks still deny a host-namespace chroot. No host capabilities are added. Chromium configuration/cache use bounded ephemeral `/tmp` directories. The real browser smoke must verify Namespace and Seccomp-BPF sandboxing under these exact restrictions.
