import { createPublicKey, verify } from "node:crypto";
import {
  DescribeInstanceAttributeCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  type RunInstancesCommandInput,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type EC2Client,
  type Instance,
} from "@aws-sdk/client-ec2";
import type { BoxProvider, LaunchRequest, ProviderState } from "./provider.js";

/**
 * AWS's published RSA certificate for ap-southeast-1, used to verify the base64-encoded
 * instance identity signature (EC2 User Guide, "Regional certificates"). Valid until
 * 2029-04-28; replace it before then.
 */
export const AP_SOUTHEAST_1_IDENTITY_CERT = `-----BEGIN CERTIFICATE-----
MIIDITCCAoqgAwIBAgIUSqP6ih+++5KF07NXngrWf26mhSUwDQYJKoZIhvcNAQEL
BQAwXDELMAkGA1UEBhMCVVMxGTAXBgNVBAgTEFdhc2hpbmd0b24gU3RhdGUxEDAO
BgNVBAcTB1NlYXR0bGUxIDAeBgNVBAoTF0FtYXpvbiBXZWIgU2VydmljZXMgTExD
MB4XDTI0MDQyOTE0MzAxNFoXDTI5MDQyODE0MzAxNFowXDELMAkGA1UEBhMCVVMx
GTAXBgNVBAgTEFdhc2hpbmd0b24gU3RhdGUxEDAOBgNVBAcTB1NlYXR0bGUxIDAe
BgNVBAoTF0FtYXpvbiBXZWIgU2VydmljZXMgTExDMIGfMA0GCSqGSIb3DQEBAQUA
A4GNADCBiQKBgQCHvRjf/0kStpJ248khtIaN8qkDN3tkw4VjvA9nvPl2anJO+eIB
UqPfQG09kZlwpWpmyO8bGB2RWqWxCwuB/dcnIob6w420k9WY5C0IIGtDRNauN3ku
vGXkw3HEnF0EjYr0pcyWUvByWY4KswZV42X7Y7XSS13hOIcL6NLA+H94/QIDAQAB
o4HfMIHcMAsGA1UdDwQEAwIHgDAdBgNVHQ4EFgQUJdbMCBXKtvCcWdwUUizvtUF2
UTgwgZkGA1UdIwSBkTCBjoAUJdbMCBXKtvCcWdwUUizvtUF2UTihYKReMFwxCzAJ
BgNVBAYTAlVTMRkwFwYDVQQIExBXYXNoaW5ndG9uIFN0YXRlMRAwDgYDVQQHEwdT
ZWF0dGxlMSAwHgYDVQQKExdBbWF6b24gV2ViIFNlcnZpY2VzIExMQ4IUSqP6ih++
+5KF07NXngrWf26mhSUwEgYDVR0TAQH/BAgwBgEB/wIBADANBgkqhkiG9w0BAQsF
AAOBgQAw13BxW11U/JL58j//Fmk7qqtrZTqXmaz1qm2WlIpJpW750MOcP4ux1uPy
eM0RdVZ4jHSMv5gtLAv/PjExBfw9n6vNCk+5GZG4Xec5DoapBZHXmfMo93sjxBFP
4x9rWn0GuwAVO9ukjYPevq2Rerilrq5VvppHtbATVNY2qecXDA==
-----END CERTIFICATE-----
`;

export interface Ec2ProfileSettings {
  /** The CloudFormation-created launch template for this profile. */
  launchTemplate: string;
  /** Per-task container limits passed to the box agent, e.g. "12g" and "3". */
  taskMemory?: string;
  taskCpus?: string;
  /** Overrides the image's command for this profile's tasks, e.g. the echo task program. */
  taskCommand?: string[];
}

export interface Ec2Settings {
  region: string;
  /** The AWS account boxes must report in their identity document. */
  accountId: string;
  profiles: Record<string, Ec2ProfileSettings>;
  /** PEM certificate or public key for identity signatures; the region's by default. */
  identityCertificate?: string;
}

const live = ["pending", "running", "stopping", "stopped"];
const states: Record<string, ProviderState> = {
  pending: "pending",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  "shutting-down": "terminated",
  terminated: "terminated",
};

const safe = {
  origin: /^https:\/\/[a-z0-9.-]+(:\d+)?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  secret: /^[A-Za-z0-9_-]{32,128}$/,
  image: /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/,
  memory: /^\d{1,4}[mg]$/,
  cpus: /^\d{1,2}(\.\d)?$/,
  argument: /^[A-Za-z0-9_./=:-]{1,200}$/,
};

/**
 * First-boot script for a box (cloud-init runs user data once). It installs Docker, takes
 * the box agent and its Node runtime from the digest-pinned worker image, blocks task
 * containers from the instance metadata service, and runs the agent as a root systemd
 * service. Every value is validated, so nothing can break out of the script.
 */
export function boxUserData(
  request: LaunchRequest,
  profile: Ec2ProfileSettings,
) {
  const { origin, boxId, secret } = request.bootstrap;
  const checks: [string, RegExp, string | undefined][] = [
    ["origin", safe.origin, origin],
    ["box id", safe.uuid, boxId],
    ["bootstrap secret", safe.secret, secret],
    ["image", safe.image, request.image],
  ];
  if (profile.taskMemory)
    checks.push(["task memory", safe.memory, profile.taskMemory]);
  if (profile.taskCpus) checks.push(["task cpus", safe.cpus, profile.taskCpus]);
  if (profile.taskCommand) {
    if (profile.taskCommand.length > 8)
      throw new Error("Unsafe box launch value: task command");
    for (const part of profile.taskCommand)
      checks.push(["task command", safe.argument, part]);
  }
  for (const [name, pattern, value] of checks)
    if (!value || !pattern.test(value))
      throw new Error(`Unsafe box launch value: ${name}`);
  const env = [
    `CHIEF_BOX_ORIGIN=${origin}`,
    `CHIEF_BOX_ID=${boxId}`,
    `CHIEF_BOX_BOOTSTRAP=${secret}`,
    "CHIEF_BOX_STATE=/var/lib/chief-box/state",
    "CHIEF_BOX_RUNNER=docker",
    `CHIEF_BOX_TASK_IMAGE=${request.image}`,
    ...(profile.taskMemory
      ? [`CHIEF_BOX_TASK_MEMORY=${profile.taskMemory}`]
      : []),
    ...(profile.taskCpus ? [`CHIEF_BOX_TASK_CPUS=${profile.taskCpus}`] : []),
    // Base64 JSON: systemd's environment files would otherwise reinterpret the quotes.
    ...(profile.taskCommand
      ? [
          `CHIEF_BOX_TASK_COMMAND_B64=${Buffer.from(JSON.stringify(profile.taskCommand)).toString("base64")}`,
        ]
      : []),
    "CHIEF_BOX_IDENTITY=ec2",
  ].join("\n");
  return `#!/bin/bash
set -euo pipefail
umask 077
install -d -m 0700 /etc/chief-box /var/lib/chief-box
cat > /etc/chief-box/env <<'CHIEF_BOX_ENV'
${env}
CHIEF_BOX_ENV
dnf install -y docker
systemctl enable --now docker
docker pull '${request.image}'
cid=$(docker create '${request.image}')
install -d -m 0755 /opt/chief-box
docker cp "$cid:/opt/chief-worker/dist/boxes" /opt/chief-box/boxes
docker cp "$cid:/usr/local/bin/node" /opt/chief-box/node
docker rm "$cid"
printf '{"type":"module"}\\n' > /opt/chief-box/package.json
cat > /opt/chief-box/firewall.sh <<'CHIEF_BOX_FIREWALL'
#!/bin/bash
# Task containers never reach the instance metadata service.
set -euo pipefail
iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
if command -v ip6tables >/dev/null && ip6tables -L DOCKER-USER >/dev/null 2>&1; then
  ip6tables -C DOCKER-USER -d fd00:ec2::254 -j DROP 2>/dev/null || ip6tables -I DOCKER-USER -d fd00:ec2::254 -j DROP
fi
CHIEF_BOX_FIREWALL
chmod 0755 /opt/chief-box/firewall.sh /opt/chief-box/node
chown -R root:root /opt/chief-box
chmod -R go-w /opt/chief-box
cat > /etc/systemd/system/chief-box-agent.service <<'CHIEF_BOX_UNIT'
[Unit]
Description=Chief box agent
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/chief-box/env
ExecStartPre=/opt/chief-box/firewall.sh
ExecStart=/opt/chief-box/node /opt/chief-box/boxes/agent-main.js
Restart=on-failure
RestartSec=5
OOMScoreAdjust=-900

[Install]
WantedBy=multi-user.target
CHIEF_BOX_UNIT
systemctl daemon-reload
systemctl enable --now chief-box-agent
`;
}

/**
 * The exact RunInstances request for a box. The IAM check builds its legitimate case from
 * this same function, so it tests what the provider really sends.
 */
export function runInstancesInput(
  request: LaunchRequest,
  profile: Ec2ProfileSettings,
): RunInstancesCommandInput {
  const tags = [
    { Key: "chief:box", Value: request.boxId },
    { Key: "chief:env", Value: request.environment },
  ];
  return {
    LaunchTemplate: { LaunchTemplateName: profile.launchTemplate },
    MinCount: 1,
    MaxCount: 1,
    ClientToken: request.clientToken,
    UserData: Buffer.from(boxUserData(request, profile)).toString("base64"),
    TagSpecifications: [
      { ResourceType: "instance", Tags: tags },
      { ResourceType: "volume", Tags: tags },
    ],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Self-managed EC2 boxes (docs/boxes.md, "EC2 provider"). Instances launch only from the
 * profile's launch template, carry this environment's tags, and are found, described and
 * swept by those tags. The controller's IAM permissions bound every call it can make.
 */
export class Ec2BoxProvider implements BoxProvider {
  readonly kind = "ec2";
  readonly canStop = true;
  private certificate: string;
  constructor(
    private client: Pick<EC2Client, "send">,
    private environment: string,
    private settings: Ec2Settings,
    /** Retries for attribute reads that EC2 has not caught up with yet. */
    private attempts = 4,
    private backoffMs = 2000,
  ) {
    this.certificate =
      settings.identityCertificate ?? AP_SOUTHEAST_1_IDENTITY_CERT;
  }

  private profile(name: string) {
    const profile = this.settings.profiles[name];
    if (!profile) throw new Error(`No EC2 settings for box profile ${name}`);
    return profile;
  }

  async launch(request: LaunchRequest) {
    if (request.environment !== this.environment)
      throw new Error("Box launch is for another environment");
    const profile = this.profile(request.profile);
    const result = await this.client.send(
      new RunInstancesCommand(runInstancesInput(request, profile)),
    );
    const id = result.Instances?.[0]?.InstanceId;
    if (!id) throw new Error("EC2 returned no instance");
    await this.refuseUnsafe(id);
    return id;
  }

  /** Waits out EC2's eventual consistency right after a launch. */
  private async attribute(id: string, attribute: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.send(
          new DescribeInstanceAttributeCommand({
            InstanceId: id,
            Attribute: attribute as any,
          }),
        );
      } catch (error) {
        const notYet =
          (error as { name?: string })?.name === "InvalidInstanceID.NotFound";
        if (!notYet || attempt >= this.attempts) throw error;
        await sleep(this.backoffMs * (attempt + 1));
      }
    }
  }

  /**
   * IAM cannot constrain termination protection, stop protection or shutdown behaviour at
   * launch, so they are read back before a box is ever recorded: one that could not be
   * terminated or stopped, or would only stop at its hard maximum, is ended and refused.
   * Both launch and adoption by search go through this check, so a refused instance is
   * never adopted; an unresolved launch is held for an operator by the reconciler.
   */
  private async refuseUnsafe(id: string) {
    const protection = await this.attribute(id, "disableApiTermination");
    const stop = await this.attribute(id, "disableApiStop");
    const shutdown = await this.attribute(
      id,
      "instanceInitiatedShutdownBehavior",
    );
    if (
      protection.DisableApiTermination?.Value === true ||
      stop.DisableApiStop?.Value === true ||
      shutdown.InstanceInitiatedShutdownBehavior?.Value !== "terminate"
    ) {
      await this.client
        .send(new TerminateInstancesCommand({ InstanceIds: [id] }))
        .catch(() => {});
      throw new Error("A box launched with unsafe instance attributes");
    }
  }

  private async instances(filters: { Name: string; Values: string[] }[]) {
    const found: Instance[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new DescribeInstancesCommand({ Filters: filters, NextToken: token }),
      );
      for (const reservation of page.Reservations ?? [])
        found.push(...(reservation.Instances ?? []));
      token = page.NextToken;
    } while (token);
    return found;
  }

  private tag(instance: Instance, key: string) {
    return instance.Tags?.find((t) => t.Key === key)?.Value;
  }

  async find(boxId: string) {
    const found = await this.instances([
      { Name: "tag:chief:box", Values: [boxId] },
      { Name: "tag:chief:env", Values: [this.environment] },
      { Name: "instance-state-name", Values: live },
    ]);
    const id = found[0]?.InstanceId;
    // A resource found after an uncertain launch is checked exactly as a launch would be.
    if (id) await this.refuseUnsafe(id);
    return id;
  }

  async describe(id: string): Promise<ProviderState> {
    try {
      const page = await this.client.send(
        new DescribeInstancesCommand({ InstanceIds: [id] }),
      );
      const instance = page.Reservations?.[0]?.Instances?.[0];
      if (!instance) return "missing";
      // Never act on an instance that is not this environment's box.
      if (this.tag(instance, "chief:env") !== this.environment)
        return "missing";
      return states[instance.State?.Name ?? ""] ?? "missing";
    } catch (error) {
      if ((error as { name?: string })?.name === "InvalidInstanceID.NotFound")
        return "missing";
      throw error;
    }
  }

  async stop(id: string) {
    await this.client.send(new StopInstancesCommand({ InstanceIds: [id] }));
  }

  async start(id: string) {
    await this.client.send(new StartInstancesCommand({ InstanceIds: [id] }));
  }

  async terminate(id: string) {
    await this.client.send(
      new TerminateInstancesCommand({ InstanceIds: [id] }),
    );
  }

  async list() {
    const found = await this.instances([
      { Name: "tag:chief:env", Values: [this.environment] },
      { Name: "tag-key", Values: ["chief:box"] },
      { Name: "instance-state-name", Values: live },
    ]);
    return found.flatMap((instance) =>
      instance.InstanceId
        ? [
            {
              providerId: instance.InstanceId,
              boxId: this.tag(instance, "chief:box"),
              environment: this.tag(instance, "chief:env"),
            },
          ]
        : [],
    );
  }

  /**
   * Verifies the AWS-signed instance identity document. Returns false for any malformed,
   * forged or mismatched proof; it never throws, because a throw would mean "retry".
   */
  async verifyIdentity(providerId: string, proof: unknown) {
    try {
      const { document, signature } = (proof ?? {}) as {
        document?: unknown;
        signature?: unknown;
      };
      if (typeof document !== "string" || typeof signature !== "string")
        return false;
      if (document.length > 4096 || signature.length > 2048) return false;
      const key = createPublicKey(this.certificate);
      const bytes = Buffer.from(document);
      const sig = Buffer.from(signature.replace(/\s+/g, ""), "base64");
      // AWS's base64 identity signature is SHA-256 with RSA over the exact document bytes.
      const signed = verify("sha256", bytes, key, sig);
      if (!signed) return false;
      const identity = JSON.parse(document) as Record<string, unknown>;
      return (
        identity.instanceId === providerId &&
        identity.accountId === this.settings.accountId &&
        identity.region === this.settings.region
      );
    } catch {
      return false;
    }
  }
}
