import { promises as fs } from 'fs';
import * as path from 'path';
import { Command, flags } from '@oclif/command';
import { safeLoadAll } from 'js-yaml';
import { ResourceGroupInput, uploadResourceGroup } from '../../client';

export default class ApplyResources extends Command {
  static description = 'Apply resources';

  static examples = [
    `$ stitch apply:resources schema.gql
Uploaded successfully!
`,
  ];

  static flags = {
    'registry-url': flags.string({ required: true, env: 'STITCH_REGISTRY_URL', description: 'Url of the registry' }),
    'dry-run': flags.boolean({ required: false, default: false, description: 'Should perform a dry run' }),
    'authorization-header': flags.string({ required: false, description: 'Custom authorization header' }),
  };

  static args = [{ name: 'resourcesPath', required: true }];

  async run() {
    const { args, flags } = this.parse(ApplyResources);
    const dryRun = flags['dry-run'];

    if (dryRun) {
      this.log(`Dry run mode ON - No changes will be made to the registry`);
    }

    const resourceGroup = await this.pathToResourceGroup(args.resourcesPath);
    const resourceCounts = Object.entries(resourceGroup).map(([key, value]) => ({ key, count: value?.length ?? 0 }));

    this.log(`${dryRun ? 'Verifying' : 'Uploading'} resources from ${args.resourcesPath}...`);
    resourceCounts.forEach(({ key, count }) => this.log(`  ${key}: ${count}`));

    await uploadResourceGroup(resourceGroup, {
      registryUrl: flags['registry-url'],
      authorizationHeader: flags['authorization-header'],
      dryRun,
    });

    this.log(`Resources from ${args.resourcesPath} were ${dryRun ? 'verified' : 'uploaded'} successfully.`);
  }

  async pathToResourceGroup(filePath: string): Promise<ResourceGroupInput> {
    const fileStats = await fs.stat(filePath);

    if (fileStats.isFile()) {
      const fileContentsBuf = await fs.readFile(filePath);
      const contents = safeLoadAll(fileContentsBuf.toString());
      return this.resourcesToResourceGroup({ [filePath]: contents });
    }

    if (fileStats.isDirectory()) {
      const dir = await fs.readdir(filePath);

      const subRgs = await Promise.all(dir.map(subPath => this.pathToResourceGroup(path.join(filePath, subPath))));
      const resultRg = subRgs.reduce(
        (rg, subRg) => ({
          schemas: safeConcat(rg.schemas, subRg.schemas),
          upstreams: safeConcat(rg.upstreams, subRg.upstreams),
          upstreamClientCredentials: safeConcat(rg.upstreamClientCredentials, subRg.upstreamClientCredentials),
          policies: safeConcat(rg.policies, subRg.policies),
        }),
        { schemas: [], upstreams: [], upstreamClientCredentials: [], policies: [] }
      );

      return resultRg;
    }

    // This should only happen with weird symlinks etc
    return { schemas: [], upstreams: [], upstreamClientCredentials: [], policies: [] };
  }

  resourcesToResourceGroup(files: { [filepath: string]: any[] }) {
    const rg: ResourceGroupInput = { schemas: [], upstreams: [], upstreamClientCredentials: [], policies: [] };

    for (const filepath in files) {
      const resources = files[filepath];
      for (const resourceWithKind of resources) {
        const { kind, ...resource } = resourceWithKind;
        // We don't bother validating the resources, since GraphQL provides a strong enough validation
        // Client-side validation can be added later on to not require a server hop
        switch (kind) {
          case 'Schema':
            rg.schemas!.push(resource);
            continue;
          case 'Upstream':
            rg.upstreams!.push(resource);
            continue;
          case 'UpstreamClientCredentials':
            rg.upstreamClientCredentials!.push(resource);
            continue;
          case 'Policy':
            rg.policies!.push(resource);
            continue;
          default:
            this.log('Unknown resource kind', filepath);
            continue;
        }
      }
    }

    return rg;
  }
}

function safeConcat<T>(...arrays: (T[] | null | undefined)[]) {
  return ([] as T[]).concat(...arrays.filter(Array.isArray));
}
