/**
 * IAM check for the box controller (docs/boxes.md, "EC2 provider"). With the gateway's own
 * AWS credentials, every RunInstances call is a DryRun: AWS answers DryRunOperation when
 * the call would be allowed and UnauthorizedOperation when it would not. Nothing launches.
 *
 *   node dist/boxes/iam-check.js <launch-template-name> <environment> [region]
 *
 * The legitimate launch must be allowed; every override must be refused. A case that AWS
 * rejects before checking permissions is reported as inconclusive, never as a pass.
 */
import {
  EC2Client,
  RunInstancesCommand,
  type RunInstancesCommandInput,
} from "@aws-sdk/client-ec2";
import { runInstancesInput } from "./ec2-provider.js";

export type IamCase = {
  name: string;
  expect: "allowed" | "refused";
  input: RunInstancesCommandInput;
};

type Tag = { Key: string; Value: string };

export function iamCases(template: string, environment: string): IamCase[] {
  const boxId = "00000000-0000-4000-8000-000000000000";
  // The legitimate request is exactly what the provider sends, plus DryRun.
  const base: RunInstancesCommandInput = {
    ...runInstancesInput(
      {
        boxId,
        clientToken: boxId,
        profile: "check",
        image: `ghcr.io/akhilvuputuri/chief-agent-coding@sha256:${"0".repeat(64)}`,
        environment,
        bootstrap: {
          origin: "https://iam-check.invalid",
          boxId,
          secret: "c".repeat(43),
        },
      },
      { launchTemplate: template },
    ),
    DryRun: true,
  };
  const own: Tag[] = [
    { Key: "chief:box", Value: boxId },
    { Key: "chief:env", Value: environment },
  ];
  const other: Tag[] = [
    { Key: "chief:box", Value: boxId },
    { Key: "chief:env", Value: `${environment}-other` },
  ];
  const tags = (instance: Tag[], volume: Tag[] = instance) => [
    { ResourceType: "instance" as const, Tags: instance },
    { ResourceType: "volume" as const, Tags: volume },
  ];
  const with_ = (
    name: string,
    input: Partial<RunInstancesCommandInput>,
  ): IamCase => ({ name, expect: "refused", input: { ...base, ...input } });
  return [
    { name: "launch from the template", expect: "allowed", input: base },
    with_("a larger instance type", { InstanceType: "m7i.16xlarge" }),
    // A Canonical-owned image: anything not owned by Amazon must be refused.
    with_("another image", { ImageId: "ami-0dad20bd1b9c8c004" }),
    with_("optional metadata tokens", {
      MetadataOptions: { HttpTokens: "optional" },
    }),
    with_("a higher metadata hop limit", {
      MetadataOptions: { HttpPutResponseHopLimit: 2 },
    }),
    with_("metadata tags", {
      MetadataOptions: { InstanceMetadataTags: "enabled" },
    }),
    with_("a key pair", { KeyName: "chief-box-check" }),
    with_("an unencrypted volume", {
      BlockDeviceMappings: [
        { DeviceName: "/dev/xvda", Ebs: { Encrypted: false, VolumeSize: 20 } },
      ],
    }),
    with_("an oversized volume", {
      BlockDeviceMappings: [
        { DeviceName: "/dev/xvda", Ebs: { Encrypted: true, VolumeSize: 1000 } },
      ],
    }),
    with_("spot capacity", { InstanceMarketOptions: { MarketType: "spot" } }),
    with_("dedicated tenancy", { Placement: { Tenancy: "dedicated" } }),
    with_("an instance profile", {
      IamInstanceProfile: { Name: "chief-box-check" },
    }),
    with_("another security group", {
      SecurityGroupIds: ["sg-00000000000000000"],
    }),
    with_("another subnet", { SubnetId: "subnet-00000000000000000" }),
    with_("another environment's tag", { TagSpecifications: tags(other) }),
    with_("an extra tag", {
      TagSpecifications: tags([...own, { Key: "owner", Value: "x" }]),
    }),
    with_("no box tag", {
      TagSpecifications: tags([{ Key: "chief:env", Value: environment }]),
    }),
    with_("an untagged volume", {
      TagSpecifications: [{ ResourceType: "instance", Tags: own }],
    }),
    with_("a volume tagged for another environment", {
      TagSpecifications: tags(own, other),
    }),
    {
      name: "no launch template",
      expect: "refused",
      input: {
        DryRun: true,
        MinCount: 1,
        MaxCount: 1,
        ImageId:
          "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
        InstanceType: "t3.small",
        TagSpecifications: tags(own),
      },
    },
  ];
}

/** Classifies one DryRun answer. */
export function outcome(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === "DryRunOperation") return "allowed";
  if (name === "UnauthorizedOperation") return "refused";
  // Anything else (e.g. a validation error before authorisation) is reported by name, so
  // the operator can tell it apart from a real refusal.
  return `other (${name ?? "unknown error"})`;
}

/** PASS when the answer matches, INCONCLUSIVE when AWS never reached authorisation. */
export function verdict(result: { expect: string; got: string }) {
  if (result.got === result.expect) return "PASS";
  // The legitimate launch must be proven allowed; anything else there is a failure.
  if (result.expect === "allowed") return "FAIL";
  return result.got.startsWith("other") ? "INCONCLUSIVE" : "FAIL";
}

export async function runIamCheck(
  client: Pick<EC2Client, "send">,
  template: string,
  environment: string,
) {
  const results: { name: string; expect: string; got: string }[] = [];
  for (const c of iamCases(template, environment)) {
    let got: string;
    try {
      await client.send(new RunInstancesCommand(c.input));
      got = "launched";
    } catch (error) {
      got = outcome(error);
    }
    results.push({ name: c.name, expect: c.expect, got });
  }
  return results;
}

if (process.argv[1]?.endsWith("iam-check.js")) {
  const [template, environment, region = "ap-southeast-1"] =
    process.argv.slice(2);
  if (!template || !environment) {
    process.stderr.write(
      "Usage: node dist/boxes/iam-check.js <launch-template> <environment> [region]\n",
    );
    process.exit(2);
  }
  const results = await runIamCheck(
    new EC2Client({ region, maxAttempts: 1 }),
    template,
    environment,
  );
  const counts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const r of results) {
    const label = verdict(r);
    counts[label]++;
    process.stdout.write(
      `${label}  ${r.name}: expected ${r.expect}, got ${r.got}\n`,
    );
  }
  process.stdout.write(
    `${counts.PASS} passed, ${counts.FAIL} failed, ${counts.INCONCLUSIVE} inconclusive\n`,
  );
  process.exit(counts.FAIL ? 1 : 0);
}
