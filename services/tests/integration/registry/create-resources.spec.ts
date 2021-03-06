import { exec } from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createTestClient, ApolloServerTestClient } from 'apollo-server-testing';
import { gql } from 'apollo-server-core';
import { mocked } from 'ts-jest/utils';
import * as nock from 'nock';
import { beforeEachDispose } from '../before-each-dispose';
import { app } from '../../../src/registry';
import { mockResourceBucket } from '../resource-bucket';
import { ResourceGroup } from '../../../src/modules/resource-repository';
import {
  PolicyType,
  PolicyDefinition,
  Schema,
  Upstream,
  UpstreamClientCredentials,
} from '../../../src/modules/resource-repository/types';
import { tmpPoliciesDir } from '../../../src/modules/config';
import mockFsForOpa from '../../helpers/mock-fs-for-opa';
import { AuthType } from '../../../src/modules/registry-schema';

jest.mock('child_process', () => ({
  exec: jest.fn((_, cb) => cb()),
}));

const mockedExec = mocked(exec, true);

const schema: Schema = {
  metadata: { namespace: 'namespace', name: 'name' },
  schema: 'type Query { something: String! }',
};

const upstream: Upstream = {
  metadata: { namespace: 'namespace', name: 'name' },
  host: 'test.api',
  auth: {
    type: AuthType.ActiveDirectory,
    activeDirectory: { authority: 'https://authority', resource: 'someResource' },
  },
};

const upstreamClientCredentials: UpstreamClientCredentials = {
  metadata: { namespace: 'namespace', name: 'name' },
  authType: AuthType.ActiveDirectory,
  activeDirectory: {
    authority: 'https://authority',
    clientId: 'myClientId',
    clientSecret: 'myClientSecret',
  },
};

const policy: PolicyDefinition = {
  metadata: { namespace: 'namespace', name: 'name' },
  type: PolicyType.opa,
  code: `real rego code
           with multiple
           lines`,
  args: {
    an: 'String',
    another: 'String!',
  },
  query: {
    gql: 'some gql',
    variables: {
      a: 'b',
    },
  },
};

const baseResourceGroup: ResourceGroup = {
  schemas: [],
  upstreams: [],
  upstreamClientCredentials: [],
  policies: [],
};

describe('Create resource', () => {
  let client: ApolloServerTestClient;
  let bucketContents: { current: ResourceGroup; policyFiles: { [name: string]: string } };

  beforeEachDispose(() => {
    client = createTestClient(app);
    bucketContents = mockResourceBucket(baseResourceGroup);

    return () => nock.cleanAll();
  });

  it('creates a Schema', async () => {
    const response = await client.mutate({
      mutation: gql`
        mutation CreateSchema($schema: SchemaInput!) {
          updateSchemas(input: [$schema]) {
            success
          }
        }
      `,
      variables: {
        schema,
      },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({ updateSchemas: { success: true } });
    expect(bucketContents.current).toMatchObject({ ...baseResourceGroup, schemas: [schema] });
  });

  it('creates a Schema using updateResourceGroup', async () => {
    const response = await client.mutate({
      mutation: gql`
        mutation UploadResources($resourceGroup: ResourceGroupInput!) {
          updateResourceGroup(input: $resourceGroup) {
            success
          }
        }
      `,
      variables: {
        resourceGroup: { schemas: [schema] },
      },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({ updateResourceGroup: { success: true } });
    expect(bucketContents.current).toMatchObject({ ...baseResourceGroup, schemas: [schema] });
  });

  it('Upstream', async () => {
    const response = await client.mutate({
      mutation: gql`
        mutation CreateUpstream($upstream: UpstreamInput!) {
          updateUpstreams(input: [$upstream]) {
            success
          }
        }
      `,
      variables: {
        upstream,
      },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({ updateUpstreams: { success: true } });
    expect(bucketContents.current).toMatchObject({ ...baseResourceGroup, upstreams: [upstream] });
  });

  it('UpstreamClientCredentials', async () => {
    const response = await client.mutate({
      mutation: gql`
        mutation CreateUpstreamClientCredentials($upstreamClientCredentials: UpstreamClientCredentialsInput!) {
          updateUpstreamClientCredentials(input: [$upstreamClientCredentials]) {
            success
          }
        }
      `,
      variables: {
        upstreamClientCredentials,
      },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({ updateUpstreamClientCredentials: { success: true } });
    expect(bucketContents.current).toMatchObject({
      ...baseResourceGroup,
      upstreamClientCredentials: [upstreamClientCredentials],
    });
  });

  it('creates an opa type policy', async () => {
    mockFsForOpa.mock();

    const response = await client.mutate({
      mutation: gql`
        mutation CreatePolicy($policy: PolicyInput!) {
          updatePolicies(input: [$policy]) {
            success
          }
        }
      `,
      variables: {
        policy,
      },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({ updatePolicies: { success: true } });
    expect(bucketContents.current).toMatchObject({ ...baseResourceGroup, policies: [policy] });

    const compiledFilename = 'namespace-name.wasm';
    const uncompiledPath = path.resolve(tmpPoliciesDir, 'namespace-name.rego');
    const compiledPath = path.resolve(tmpPoliciesDir, compiledFilename);
    const regoCode = `package policy\n${policy.code}`;
    expect(fs.writeFile).toHaveBeenCalledWith(uncompiledPath, regoCode);
    expect(fs.unlink).toHaveBeenCalledWith(uncompiledPath);
    expect(fs.unlink).toHaveBeenCalledWith(compiledPath);
    expect(fs.readFile).toHaveBeenCalledWith(compiledPath);
    expect(bucketContents.policyFiles).toEqual({ [compiledFilename]: 'compiled rego code' });

    const expectedCommand = `opa build -d ${uncompiledPath} -o ${compiledPath} 'data.policy = result'`;
    expect(mockedExec.mock.calls[0][0]).toBe(expectedCommand);

    mockFsForOpa.restore();
  });

  it('creates an opa type policy using updateResourceGroup', async () => {
    mockFsForOpa.mock();

    const response = await client.mutate({
      mutation: gql`
        mutation CreatePolicy($resourceGroup: ResourceGroupInput!) {
          updateResourceGroup(input: $resourceGroup) {
            success
          }
        }
      `,
      variables: {
        resourceGroup: { policies: [policy] },
      },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({ updateResourceGroup: { success: true } });
    expect(bucketContents.current).toMatchObject({ ...baseResourceGroup, policies: [policy] });

    const compiledFilename = 'namespace-name.wasm';
    const uncompiledPath = path.resolve(tmpPoliciesDir, 'namespace-name.rego');
    const compiledPath = path.resolve(tmpPoliciesDir, compiledFilename);
    const regoCode = `package policy\n${policy.code}`;
    expect(fs.writeFile).toHaveBeenCalledWith(uncompiledPath, regoCode);
    expect(fs.unlink).toHaveBeenCalledWith(uncompiledPath);
    expect(fs.unlink).toHaveBeenCalledWith(compiledPath);
    expect(fs.readFile).toHaveBeenCalledWith(compiledPath);
    expect(bucketContents.policyFiles).toEqual({ [compiledFilename]: 'compiled rego code' });

    const expectedCommand = `opa build -d ${uncompiledPath} -o ${compiledPath} 'data.policy = result'`;
    expect(mockedExec.mock.calls[0][0]).toBe(expectedCommand);

    mockFsForOpa.restore();
  });
});
