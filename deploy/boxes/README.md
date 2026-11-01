# Boxed sub-agents: AWS setup (owner-applied)

Design: [docs/boxes.md](../../docs/boxes.md). This stack creates no instances. It creates:

- a security group with no inbound rules and outbound HTTPS/HTTP only;
- two launch templates, `chief-box-<env>-coding` and `chief-box-<env>-echo`, both with:
  - Amazon Linux 2023;
  - IMDSv2 required, hop limit 1, IPv6 metadata endpoint and metadata tags disabled;
  - an encrypted gp3 root volume deleted on termination;
  - `InstanceInitiatedShutdownBehavior=terminate`;
  - no instance profile and no key pair;
- a managed policy attached to the gateway's existing IAM user. The policy:
  - allows launches only from those templates, and only from Amazon's images or this account's images tagged `chief:box-image` for this environment;
  - allows only the listed instance types, required IMDSv2, hop limit 1, default tenancy, on-demand capacity and encrypted gp3 volumes of at most 200 GiB;
  - requires the `chief:box` and `chief:env` tags, and no other tags;
  - allows start, stop and terminate only on this environment's tagged boxes;
  - allows no `iam:PassRole` and no `ModifyInstanceAttribute`.

Claude prepares these steps; the owner runs them with administrator credentials. Nothing here passes through chat.

## 1. Choose the network

Boxes need a public subnet, so they get a public IP and need no NAT gateway. The default VPC's subnets qualify:

```bash
aws ec2 describe-subnets --region ap-southeast-1 --filters Name=default-for-az,Values=true --query 'Subnets[].{Subnet:SubnetId,Vpc:VpcId,Zone:AvailabilityZone}' --output table
```

## 2. Confirm the controller user

This is the IAM user whose access keys the gateway uses: `chief-coding-controller`. (It used to hold the CodeBuild controller policy too, removed on 20 October with CodeBuild.)

```bash
aws iam list-users --query 'Users[].UserName' --output table
```

## 3. Check the vCPU quota

The default coding instance (`m7i.xlarge`) has 4 vCPUs, and coding allows 2 boxes at once, so 8 vCPUs plus the echo box are needed.

```bash
aws service-quotas get-service-quota --region ap-southeast-1 --service-code ec2 --quota-code L-1216C47A --query 'Quota.Value'
```

## 4. Deploy the stack

```bash
aws cloudformation deploy --region ap-southeast-1 --stack-name chief-boxes-prod --template-file deploy/boxes/boxes.json --capabilities CAPABILITY_IAM --parameter-overrides Environment=prod VpcId=vpc-XXXX SubnetId=subnet-XXXX ControllerUserName=XXXX
```

Then read the outputs. The launch template names and the account ID go into `config/boxes.json` in phase 2c-2:

```bash
aws cloudformation describe-stacks --region ap-southeast-1 --stack-name chief-boxes-prod --query 'Stacks[0].Outputs' --output table
```

## 5. Verify the permissions (no instance launches)

After the gateway runs a release that contains `dist/boxes/iam-check.js`, check that the controller's own credentials allow only the legitimate launch. Every call is a `DryRun`:

```bash
ssh -F <ops>/ssh_config chief-lightsail 'cd /opt/hermes-companion && docker compose exec -T gateway node dist/boxes/iam-check.js chief-box-prod-echo prod && docker compose exec -T gateway node dist/boxes/iam-check.js chief-box-prod-coding prod'
```

- **Expected result:** one `PASS … allowed` line for the template launch, and `PASS … refused` for every override (instance type, image, metadata options, key pair, volume, spot, tenancy, instance profile, tags, no template).
- **Any `FAIL`:** stop and review the policy.
- **An `INCONCLUSIVE` line:** AWS rejected an override before checking permissions (for example a made-up image or subnet ID), so that case proves nothing either way. These do not fail the check; review each one. The legitimate launch is different: anything other than `allowed` for it is a `FAIL`.

## Baked coding image

Optional, and separate from the boxes stack. `box-image.json` creates a weekly Image Builder pipeline that bakes Docker and the worker image pinned on `main` into the latest Amazon Linux 2023, tests it on an instance launched from the result, publishes it through the SSM parameter `/imagebuilder/chief/boxes/<env>/coding-ami`, and keeps the newest three images. The build role belongs to the build and test instances only: boxes still have no instance profile.

1. Create the pipeline, using the boxes stack's VPC and subnet:

   ```bash
   aws cloudformation deploy --region ap-southeast-1 --stack-name chief-box-image-prod --template-file deploy/boxes/box-image.json --capabilities CAPABILITY_IAM --parameter-overrides Environment=prod VpcId=vpc-XXXX SubnetId=subnet-XXXX
   ```

2. Build the first image, and wait until the parameter exists (about 20–40 minutes, estimated):

   ```bash
   aws imagebuilder start-image-pipeline-execution --region ap-southeast-1 --image-pipeline-arn "$(aws cloudformation describe-stacks --region ap-southeast-1 --stack-name chief-box-image-prod --query "Stacks[0].Outputs[?OutputKey=='PipelineArn'].OutputValue" --output text)"
   ```

   ```bash
   aws ssm get-parameter --region ap-southeast-1 --name /imagebuilder/chief/boxes/prod/coding-ami --query Parameter.Value --output text
   ```

3. Point coding boxes at it. Other parameters keep their values:

   ```bash
   aws cloudformation deploy --region ap-southeast-1 --stack-name chief-boxes-prod --template-file deploy/boxes/boxes.json --capabilities CAPABILITY_IAM --parameter-overrides CodingImage=resolve:ssm:/imagebuilder/chief/boxes/prod/coding-ami
   ```

4. Make that version the default. Boxes launch the template's default version, and a stack update does not move it:

   ```bash
   aws ec2 modify-launch-template --region ap-southeast-1 --launch-template-name chief-box-prod-coding --default-version "$(aws cloudformation describe-stacks --region ap-southeast-1 --stack-name chief-boxes-prod --query "Stacks[0].Outputs[?OutputKey=='CodingLaunchTemplateLatestVersion'].OutputValue" --output text)"
   ```

5. Confirm that the default version uses it, then rerun the IAM check from [Verify the permissions](#5-verify-the-permissions-no-instance-launches). "Launch from the template" now proves that the controller can launch the baked image:

   ```bash
   aws ec2 describe-launch-template-versions --region ap-southeast-1 --launch-template-name chief-box-prod-coding --versions '$Default' --query 'LaunchTemplateVersions[0].LaunchTemplateData.ImageId' --output text
   ```

**To undo:** redeploy the boxes stack with `CodingImage=resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`, then repeat steps 4 and 5. The boot script works on both images. A bad weekly image is undone the same way until a good one is built.

**A new worker image** needs no rebuild: a box pulls only the layers missing from the baked image. To refresh sooner than weekly, rerun step 2.

**A failed build** keeps the last good image, and nothing alerts on it. Check the state and reason of recent builds here:

```bash
aws imagebuilder list-image-pipeline-images --region ap-southeast-1 --image-pipeline-arn "$(aws cloudformation describe-stacks --region ap-southeast-1 --stack-name chief-box-image-prod --query "Stacks[0].Outputs[?OutputKey=='PipelineArn'].OutputValue" --output text)" --query 'imageSummaryList[].[dateCreated,state.status,state.reason]' --output table
```

**Changing the components or the recipe:** Image Builder versions cannot be edited. Raise the component's `Version` and the recipe's `Version` in the same change, or the stack update fails.

## Rollback

1. While boxes are still on, close every box with the probe (`docker compose exec -T gateway node dist/boxes/probe.js close <box-id>`), and wait until each one shows `terminated` in `probe.js status`. Turning boxes off first would also stop the reconciler and its sweep.
2. Set `BOXES_RUNTIME=off` and restart the gateway.
3. Confirm that no `chief:env=prod` instance or volume remains:

   ```bash
   aws ec2 describe-instances --region ap-southeast-1 --filters Name=tag:chief:env,Values=prod Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId'
   ```

4. Delete the stack:

   ```bash
   aws cloudformation delete-stack --region ap-southeast-1 --stack-name chief-boxes-prod
   ```
