/**
 * IAM check for the box controller (docs/boxes.md, "EC2 provider"). With the gateway's own
 * AWS credentials, every RunInstances call is a DryRun: AWS answers DryRunOperation when
 * the call would be allowed and UnauthorizedOperation when it would not. Nothing launches.
 *
 *   node dist/boxes/iam-check.js <launch-template-name> <environment> [region]
 *
 * The legitimate launch must be allowed; every override must be refused.
 */
import {
  EC2Client,
  RunInstancesCommand,
  type RunInstancesCommandInput,
} from "@aws-sdk/client-ec2";

export type IamCase = {
  name: string;
  expect: "allowed" | "refused";
  input: RunInstancesCommandInput;
};

export function iamCases(template: string, environment: string): IamCase[] {
  const tags = (extra: { Key: string; Value: string }[] = []) => [
    {
      ResourceType: "instance" as const,
      Tags: [
        { Key: "chief:box", Value: "00000000-0000-4000-8000-000000000000" },
        { Key: "chief:env", Value: environment },
        ...extra,
      ],
    },
  ];
  const base: RunInstancesCommandInput = {
    DryRun: true,
    MinCount: 1,
    MaxCount: 1,
    LaunchTemplate: { LaunchTemplateName: template },
    TagSpecifications: tags(),
  };
  return [
    { name: "launch from the template", expect: "allowed", input: base },
    {
      name: "a larger instance type",
      expect: "refused",
      input: { ...base, InstanceType: "m7i.16xlarge" },
    },
    {
      name: "another image",
      expect: "refused",
      // A Canonical-owned image: anything not owned by Amazon must be refused.
      input: { ...base, ImageId: "ami-0dad20bd1b9c8c004" },
    },
    {
      name: "optional metadata tokens",
      expect: "refused",
      input: { ...base, MetadataOptions: { HttpTokens: "optional" } },
    },
    {
      name: "a higher metadata hop limit",
      expect: "refused",
      input: { ...base, MetadataOptions: { HttpPutResponseHopLimit: 2 } },
    },
    {
      name: "metadata tags",
      expect: "refused",
      input: { ...base, MetadataOptions: { InstanceMetadataTags: "enabled" } },
    },
    {
      name: "a key pair",
      expect: "refused",
      input: { ...base, KeyName: "chief-box-check" },
    },
    {
      name: "an unencrypted volume",
      expect: "refused",
      input: {
        ...base,
        BlockDeviceMappings: [
          {
            DeviceName: "/dev/xvda",
            Ebs: { Encrypted: false, VolumeSize: 20 },
          },
        ],
      },
    },
    {
      name: "an oversized volume",
      expect: "refused",
      input: {
        ...base,
        BlockDeviceMappings: [
          {
            DeviceName: "/dev/xvda",
            Ebs: { Encrypted: true, VolumeSize: 1000 },
          },
        ],
      },
    },
    {
      name: "spot capacity",
      expect: "refused",
      input: { ...base, InstanceMarketOptions: { MarketType: "spot" } },
    },
    {
      name: "dedicated tenancy",
      expect: "refused",
      input: { ...base, Placement: { Tenancy: "dedicated" } },
    },
    {
      name: "an instance profile",
      expect: "refused",
      input: { ...base, IamInstanceProfile: { Name: "chief-box-check" } },
    },
    {
      name: "another environment's tag",
      expect: "refused",
      input: {
        ...base,
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              {
                Key: "chief:box",
                Value: "00000000-0000-4000-8000-000000000000",
              },
              { Key: "chief:env", Value: `${environment}-other` },
            ],
          },
        ],
      },
    },
    {
      name: "an extra tag",
      expect: "refused",
      input: {
        ...base,
        TagSpecifications: tags([{ Key: "owner", Value: "x" }]),
      },
    },
    {
      name: "no box tag",
      expect: "refused",
      input: {
        ...base,
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [{ Key: "chief:env", Value: environment }],
          },
        ],
      },
    },
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
        TagSpecifications: tags(),
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
  let failed = 0;
  for (const r of results) {
    const ok = r.got === r.expect;
    if (!ok) failed++;
    process.stdout.write(
      `${ok ? "PASS" : "FAIL"}  ${r.name}: expected ${r.expect}, got ${r.got}\n`,
    );
  }
  process.exit(failed ? 1 : 0);
}
