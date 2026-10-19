import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  AP_SOUTHEAST_1_IDENTITY_CERT,
  Ec2BoxProvider,
  boxUserData,
  runInstancesInput,
} from "../src/boxes/ec2-provider.js";
import {
  iamCases,
  outcome,
  runIamCheck,
  verdict,
} from "../src/boxes/iam-check.js";
import type { LaunchRequest } from "../src/boxes/provider.js";

const boxId = "11111111-1111-4111-8111-111111111111";
const image = `ghcr.io/akhilvuputuri/chief-agent-coding@sha256:${"a".repeat(64)}`;
const request: LaunchRequest = {
  boxId,
  clientToken: boxId,
  profile: "echo",
  image,
  environment: "prod",
  bootstrap: {
    origin: "https://companion.52-77-47-24.sslip.io",
    boxId,
    secret: "s".repeat(43),
  },
};

test("the bootstrap script is valid bash, pins the image and isolates the agent", () => {
  const script = boxUserData(request, {
    launchTemplate: "t",
    taskMemory: "12g",
    taskCpus: "3",
  });
  const check = spawnSync("bash", ["-n"], { input: script });
  assert.equal(check.status, 0, String(check.stderr));
  for (const line of [
    `CHIEF_BOX_ID=${boxId}`,
    `CHIEF_BOX_TASK_IMAGE=${image}`,
    "CHIEF_BOX_TASK_MEMORY=12g",
    "CHIEF_BOX_IDENTITY=ec2",
    "iptables -I DOCKER-USER -d 169.254.169.254 -j DROP",
    "ExecStart=/opt/chief-box/node /opt/chief-box/boxes/agent-main.js",
    "ExecStartPre=/opt/chief-box/firewall.sh",
    `docker pull '${image}'`,
  ])
    assert.ok(script.includes(line), line);
  // The environment file is written with a quoted heredoc: nothing in it is expanded.
  assert.ok(script.includes("<<'CHIEF_BOX_ENV'"));
});

test("unsafe launch values are refused before anything reaches EC2", () => {
  for (const bad of [
    { ...request, image: "ghcr.io/x/y:latest" },
    {
      ...request,
      bootstrap: { ...request.bootstrap, origin: "https://x.io'; rm -rf /" },
    },
    {
      ...request,
      bootstrap: {
        ...request.bootstrap,
        secret: "$(curl evil)" + "a".repeat(40),
      },
    },
    { ...request, bootstrap: { ...request.bootstrap, boxId: "not-a-uuid" } },
  ])
    assert.throws(
      () => boxUserData(bad, { launchTemplate: "t" }),
      /Unsafe box launch value/,
    );
  assert.throws(
    () =>
      boxUserData(request, { launchTemplate: "t", taskMemory: "12g; reboot" }),
    /task memory/,
  );
});

function fakeEc2(responses: Record<string, (input: any) => any>) {
  const calls: { name: string; input: any }[] = [];
  return {
    calls,
    client: {
      send: async (command: any) => {
        const name = command.constructor.name;
        calls.push({ name, input: command.input });
        const respond = responses[name];
        if (!respond) throw new Error(`unexpected ${name}`);
        return respond(command.input);
      },
    },
  };
}

const settings = {
  region: "ap-southeast-1",
  accountId: "123456789012",
  profiles: { echo: { launchTemplate: "chief-box-prod-echo" } },
};

const safeAttributes = (input: any) =>
  input.Attribute === "disableApiTermination"
    ? { DisableApiTermination: { Value: false } }
    : input.Attribute === "disableApiStop"
      ? { DisableApiStop: { Value: false } }
      : { InstanceInitiatedShutdownBehavior: { Value: "terminate" } };

test("a launch uses the profile's template, an idempotent token, tags and checked attributes", async () => {
  // EC2 is eventually consistent: the first attribute read after launch may not see it.
  let notYet = true;
  const ec2 = fakeEc2({
    RunInstancesCommand: () => ({ Instances: [{ InstanceId: "i-123" }] }),
    DescribeInstanceAttributeCommand: (input: any) => {
      if (notYet) {
        notYet = false;
        throw Object.assign(new Error("not yet"), {
          name: "InvalidInstanceID.NotFound",
        });
      }
      return safeAttributes(input);
    },
  });
  const provider = new Ec2BoxProvider(
    ec2.client as any,
    "prod",
    settings,
    4,
    1,
  );
  assert.equal(await provider.launch(request), "i-123");
  assert.deepEqual(
    ec2.calls
      .filter((c) => c.name === "DescribeInstanceAttributeCommand")
      .map((c) => c.input.Attribute),
    [
      "disableApiTermination",
      "disableApiTermination",
      "disableApiStop",
      "instanceInitiatedShutdownBehavior",
    ],
  );
  // The provider's request is the shared one the IAM check also uses.
  const { UserData: _sent, ...sent } = ec2.calls[0]!.input;
  const { UserData: _built, ...built } = runInstancesInput(
    request,
    settings.profiles.echo,
  );
  assert.deepEqual(sent, built);
  const run = ec2.calls[0]!.input;
  assert.deepEqual(run.LaunchTemplate, {
    LaunchTemplateName: "chief-box-prod-echo",
  });
  assert.equal(run.ClientToken, boxId);
  assert.equal(run.InstanceType, undefined);
  assert.equal(run.ImageId, undefined);
  assert.deepEqual(
    run.TagSpecifications.map((t: any) => [t.ResourceType, t.Tags]),
    [
      [
        "instance",
        [
          { Key: "chief:box", Value: boxId },
          { Key: "chief:env", Value: "prod" },
        ],
      ],
      [
        "volume",
        [
          { Key: "chief:box", Value: boxId },
          { Key: "chief:env", Value: "prod" },
        ],
      ],
    ],
  );
  assert.match(
    Buffer.from(run.UserData, "base64").toString(),
    /CHIEF_BOX_BOOTSTRAP=s{43}/,
  );
  await assert.rejects(
    provider.launch({ ...request, environment: "staging" }),
    /another environment/,
  );

  // Instances that could not be terminated or stopped, or would only stop, are refused,
  // whether launched or found after an uncertain launch.
  for (const bad of [
    { DisableApiTermination: { Value: true } },
    { DisableApiStop: { Value: true } },
    { InstanceInitiatedShutdownBehavior: { Value: "stop" } },
  ]) {
    const respond = (input: any) => ({ ...safeAttributes(input), ...bad });
    const unsafe = fakeEc2({
      RunInstancesCommand: () => ({ Instances: [{ InstanceId: "i-bad" }] }),
      DescribeInstancesCommand: () => ({
        Reservations: [{ Instances: [{ InstanceId: "i-bad" }] }],
      }),
      DescribeInstanceAttributeCommand: respond,
      TerminateInstancesCommand: () => ({}),
    });
    const p = new Ec2BoxProvider(unsafe.client as any, "prod", settings, 0, 1);
    await assert.rejects(p.launch(request), /unsafe instance attributes/);
    await assert.rejects(p.find(boxId), /unsafe instance attributes/);
    assert.deepEqual(
      unsafe.calls
        .filter((c) => c.name === "TerminateInstancesCommand")
        .map((c) => c.input),
      [{ InstanceIds: ["i-bad"] }, { InstanceIds: ["i-bad"] }],
    );
  }
});

test("find, describe and list see only this environment's live boxes", async () => {
  const instance = (id: string, env: string, state: string, box = boxId) => ({
    InstanceId: id,
    State: { Name: state },
    Tags: [
      { Key: "chief:box", Value: box },
      { Key: "chief:env", Value: env },
    ],
  });
  let page = 0;
  const ec2 = fakeEc2({
    DescribeInstancesCommand: (input: any) => {
      if (input.InstanceIds) {
        const id = input.InstanceIds[0];
        if (id === "i-gone") {
          const error = new Error("not found");
          (error as any).name = "InvalidInstanceID.NotFound";
          throw error;
        }
        if (id === "i-other")
          return {
            Reservations: [{ Instances: [instance(id, "staging", "running")] }],
          };
        return {
          Reservations: [
            { Instances: [instance(id, "prod", "shutting-down")] },
          ],
        };
      }
      page++;
      return page === 1
        ? {
            Reservations: [{ Instances: [instance("i-1", "prod", "running")] }],
            NextToken: "n",
          }
        : {
            Reservations: [
              { Instances: [instance("i-2", "prod", "stopped", "x")] },
            ],
          };
    },
  });
  const provider = new Ec2BoxProvider(ec2.client as any, "prod", settings);
  assert.deepEqual(await provider.list(), [
    { providerId: "i-1", boxId, environment: "prod" },
    { providerId: "i-2", boxId: "x", environment: "prod" },
  ]);
  const filters = ec2.calls[0]!.input.Filters;
  assert.deepEqual(filters[0], { Name: "tag:chief:env", Values: ["prod"] });
  assert.equal(await provider.describe("i-3"), "terminated");
  assert.equal(await provider.describe("i-gone"), "missing");
  assert.equal(await provider.describe("i-other"), "missing");
});

test("identity is verified against the signed document, instance, account and region", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const provider = new Ec2BoxProvider(
    { send: async () => ({}) } as any,
    "prod",
    {
      ...settings,
      identityCertificate: pem,
    },
  );
  const document = JSON.stringify({
    instanceId: "i-123",
    accountId: "123456789012",
    region: "ap-southeast-1",
  });
  const signed = (doc: string, alg = "sha256") =>
    sign(alg, Buffer.from(doc), privateKey).toString("base64");
  assert.equal(
    await provider.verifyIdentity("i-123", {
      document,
      signature: signed(document),
    }),
    true,
  );
  // Only SHA-256, as AWS documents for this signature.
  assert.equal(
    await provider.verifyIdentity("i-123", {
      document,
      signature: signed(document, "sha1"),
    }),
    false,
  );
  assert.equal(
    await provider.verifyIdentity("i-999", {
      document,
      signature: signed(document),
    }),
    false,
  );
  const otherAccount = document.replace("123456789012", "999999999999");
  assert.equal(
    await provider.verifyIdentity("i-123", {
      document: otherAccount,
      signature: signed(otherAccount),
    }),
    false,
  );
  assert.equal(
    await provider.verifyIdentity("i-123", {
      document: otherAccount,
      signature: signed(document),
    }),
    false,
  );
  for (const malformed of [
    undefined,
    {},
    { document },
    { document: 1, signature: "x" },
    "x",
  ])
    assert.equal(await provider.verifyIdentity("i-123", malformed), false);
  // The pinned regional certificate is a real RSA certificate.
  assert.equal(
    createPublicKey(AP_SOUTHEAST_1_IDENTITY_CERT).asymmetricKeyType,
    "rsa",
  );
});

test("the CloudFormation template keeps boxes closed and the controller narrow", async () => {
  const template = JSON.parse(
    await readFile(
      new URL("../deploy/boxes/boxes.json", import.meta.url),
      "utf8",
    ),
  );
  const resources = template.Resources;
  assert.equal(
    resources.BoxSecurityGroup.Properties.SecurityGroupIngress,
    undefined,
  );
  assert.deepEqual(
    resources.BoxSecurityGroup.Properties.SecurityGroupEgress.map(
      (r: any) => r.FromPort,
    ).sort(),
    [443, 80],
  );
  for (const name of ["CodingLaunchTemplate", "EchoLaunchTemplate"]) {
    const data = resources[name].Properties.LaunchTemplateData;
    assert.deepEqual(data.MetadataOptions, {
      HttpEndpoint: "enabled",
      HttpTokens: "required",
      HttpPutResponseHopLimit: 1,
      HttpProtocolIpv6: "disabled",
      InstanceMetadataTags: "disabled",
    });
    assert.equal(data.InstanceInitiatedShutdownBehavior, "terminate");
    assert.equal(data.DisableApiTermination, false);
    assert.equal(data.IamInstanceProfile, undefined);
    assert.equal(data.KeyName, undefined);
    assert.equal(data.UserData, undefined);
    for (const volume of data.BlockDeviceMappings)
      assert.deepEqual(
        [
          volume.Ebs.Encrypted,
          volume.Ebs.DeleteOnTermination,
          volume.Ebs.VolumeType,
        ],
        [true, true, "gp3"],
      );
  }
  const statements =
    resources.ControllerPolicy.Properties.PolicyDocument.Statement;
  const actions = statements.flatMap((s: any) => [s.Action].flat());
  for (const forbidden of [
    "iam:PassRole",
    "ec2:ModifyInstanceAttribute",
    "ec2:*",
    "*",
  ])
    assert.ok(!actions.includes(forbidden), forbidden);
  const launch = statements.find(
    (s: any) => s.Sid === "LaunchInstancesFromBoxTemplatesOnly",
  );
  assert.equal(
    launch.Condition.StringEquals["ec2:MetadataHttpTokens"],
    "required",
  );
  assert.equal(launch.Condition.StringEquals["ec2:Tenancy"], "default");
  assert.equal(
    launch.Condition.StringEquals["ec2:InstanceMarketType"],
    "on-demand",
  );
  assert.equal(
    launch.Condition.NumericLessThanEquals[
      "ec2:MetadataHttpPutResponseHopLimit"
    ],
    "1",
  );
  assert.deepEqual(
    launch.Condition["ForAllValues:StringEquals"]["aws:TagKeys"],
    ["chief:box", "chief:env"],
  );
  const manage = statements.find((s: any) => s.Sid === "ManageOwnBoxesOnly");
  assert.ok(manage.Condition.StringEquals["ec2:ResourceTag/chief:env"]);
  const tagging = statements.find((s: any) => s.Sid === "TagOnlyAtLaunch");
  assert.equal(
    tagging.Condition.StringEquals["ec2:CreateAction"],
    "RunInstances",
  );
});

test("the IAM check expects one allowed launch and refusals for every override", async () => {
  const cases = iamCases("chief-box-prod-echo", "prod");
  assert.deepEqual(
    cases.filter((c) => c.expect === "allowed").map((c) => c.name),
    ["launch from the template"],
  );
  assert.ok(cases.length >= 15);
  assert.ok(cases.every((c) => c.input.DryRun === true));
  const named = (name: string) => Object.assign(new Error(name), { name });
  assert.equal(outcome(named("DryRunOperation")), "allowed");
  assert.equal(outcome(named("UnauthorizedOperation")), "refused");
  assert.equal(
    outcome(named("InvalidAMIID.NotFound")),
    "other (InvalidAMIID.NotFound)",
  );
  let first = true;
  const results = await runIamCheck(
    {
      send: async () => {
        const allowed = first;
        first = false;
        throw named(allowed ? "DryRunOperation" : "UnauthorizedOperation");
      },
    } as any,
    "chief-box-prod-echo",
    "prod",
  );
  assert.ok(results.every((r) => r.got === r.expect));
});

test("identity verification works from an X.509 certificate, as AWS publishes it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "box-cert-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const made = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=box-test",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  const certificate = await readFile(join(dir, "cert.pem"), "utf8");
  const key = await readFile(join(dir, "key.pem"), "utf8");
  const provider = new Ec2BoxProvider(
    { send: async () => ({}) } as any,
    "prod",
    {
      ...settings,
      identityCertificate: certificate,
    },
  );
  const document = JSON.stringify({
    instanceId: "i-1",
    accountId: "123456789012",
    region: "ap-southeast-1",
  });
  const signature = sign("sha256", Buffer.from(document), key).toString(
    "base64",
  );
  assert.equal(
    await provider.verifyIdentity("i-1", { document, signature }),
    true,
  );
});

test("the IAM check's legitimate case is the provider's request, and its verdicts are honest", () => {
  const cases = iamCases("chief-box-prod-echo", "prod");
  const base = cases[0]!.input;
  const { UserData: _a, DryRun, ...checked } = base;
  const { UserData: _b, ...real } = runInstancesInput(
    {
      ...request,
      boxId: "00000000-0000-4000-8000-000000000000",
      clientToken: "00000000-0000-4000-8000-000000000000",
      bootstrap: {
        ...request.bootstrap,
        boxId: "00000000-0000-4000-8000-000000000000",
      },
    },
    { launchTemplate: "chief-box-prod-echo" },
  );
  assert.equal(DryRun, true);
  assert.deepEqual(checked, real);
  assert.deepEqual(
    (base.TagSpecifications ?? []).map((t) => t.ResourceType),
    ["instance", "volume"],
  );
  for (const name of [
    "an untagged volume",
    "a volume tagged for another environment",
    "another subnet",
    "another security group",
  ])
    assert.ok(
      cases.some((c) => c.name === name),
      name,
    );
  assert.equal(verdict({ expect: "refused", got: "refused" }), "PASS");
  assert.equal(verdict({ expect: "allowed", got: "refused" }), "FAIL");
  assert.equal(verdict({ expect: "refused", got: "launched" }), "FAIL");
  assert.equal(
    verdict({ expect: "refused", got: "other (InvalidAMIID.NotFound)" }),
    "INCONCLUSIVE",
  );
});
