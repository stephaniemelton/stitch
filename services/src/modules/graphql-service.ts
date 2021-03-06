import { Unsubscriber, GraphQLServiceConfig, SchemaChangeCallback, gql } from 'apollo-server-core';
import { parse, execute, DocumentNode } from 'graphql';
import { Observable, Subscription } from 'rxjs';
import { shareReplay, map, take, tap, catchError, skip } from 'rxjs/operators';
import type { GraphQLRequestContextExecutionDidStart } from 'apollo-server-types';
import { directiveMap, sdl as directivesSdl } from './directives';
import { ResourceGroup, PolicyDefinition, Schema, ResourceMetadata } from './resource-repository';
import { buildSchemaFromFederatedTypeDefs } from './build-federated-schema';
import * as baseSchema from './base-schema';
import { ActiveDirectoryAuth, AuthenticationConfig } from './upstream-authentication';
import logger from './logger';
import { AuthorizationConfig, PolicyExecutor, policyScalarResolvers } from './directives/policy';

export function createGraphQLService(config: { resourceGroups: Observable<ResourceGroup> }) {
  let currentSchemaConfig: GraphQLServiceConfig;

  const subscription = new Subscription();
  const newSchemaConfigs = config.resourceGroups.pipe(
    tap(() => logger.info('Loading new resources')),
    map(createSchemaConfig),
    catchError((error, obs) => {
      logger.error(error, 'Error creating schema config');
      return obs.pipe(skip(1));
    }),
    shareReplay(1)
  );
  const startListening = () =>
    newSchemaConfigs.subscribe((schemaConfig: GraphQLServiceConfig) => {
      currentSchemaConfig = schemaConfig;
      logger.info('New resources loaded');
    });

  return {
    async load(): Promise<GraphQLServiceConfig> {
      subscription.add(startListening());
      currentSchemaConfig = await newSchemaConfigs.pipe(take(1)).toPromise();

      return {
        schema: currentSchemaConfig.schema,
        executor(requestContext) {
          return currentSchemaConfig!.executor(requestContext);
        },
      };
    },
    onSchemaChange(callback: SchemaChangeCallback): Unsubscriber {
      const sub = newSchemaConfigs.pipe(map(sc => sc.schema)).subscribe(callback);
      subscription.add(sub);

      return sub.unsubscribe.bind(sub);
    },
    executor<TContext>(requestContext: GraphQLRequestContextExecutionDidStart<TContext>) {
      return currentSchemaConfig!.executor(requestContext);
    },
    dispose() {
      subscription.unsubscribe();
    },
  };
}

function buildPolicyGqlQuery(policy: PolicyDefinition): DocumentNode {
  const argStr = policy.args
    ? `(${Object.entries(policy.args)
        .map(([argName, argType]) => `${argName}: ${argType}`)
        .join(',')})`
    : '';

  return gql`
        extend type Policy {
            ${getPolicyQueryName(policy.metadata)}${argStr}: PolicyResult!
              @policyQuery(namespace: "${policy.metadata.namespace}", name: "${policy.metadata.name}")
        }
        `;
}

export function createSchemaConfig(rg: ResourceGroup): GraphQLServiceConfig {
  const activeDirectoryAuth = new ActiveDirectoryAuth();
  const upstreamsByHost = new Map(rg.upstreams.map(u => [u.host, u]));
  const upstreamClientCredentialsByAuthority = new Map(
    rg.upstreamClientCredentials.map(u => [u.activeDirectory.authority, u])
  );
  const schemas = rg.schemas.length === 0 ? [defaultSchema] : [initialSchema, ...rg.schemas];
  const policies = rg.policies ?? [];

  const authenticationConfig: AuthenticationConfig = {
    getUpstreamByHost(host: string) {
      return upstreamsByHost.get(host);
    },
    getUpstreamClientCredentialsByAuthority(authority: string) {
      return upstreamClientCredentialsByAuthority.get(authority);
    },
    activeDirectoryAuth,
  };

  const authorizationConfig: AuthorizationConfig = {
    policies: rg.policies,
    policyAttachments: rg.policyAttachments,
    policyExecutor: new PolicyExecutor(),
    basePolicy: rg.basePolicy,
  };

  const schemaTypeDefs = schemas.map(s => [`${s.metadata.namespace}/${s.metadata.name}`, parse(s.schema)]);
  const policyQueryTypeDefs = policies.map(p => [getPolicyQueryName(p.metadata), buildPolicyGqlQuery(p)]);
  const schema = buildSchemaFromFederatedTypeDefs({
    typeDefs: Object.fromEntries([...schemaTypeDefs, ...policyQueryTypeDefs]),
    baseTypeDefs: baseSchema.baseTypeDef,
    directiveTypeDefs: directivesSdl,
    resolvers: { ...baseSchema.resolvers, ...policyScalarResolvers },
    schemaDirectives: directiveMap,
    schemaDirectivesContext: { authenticationConfig, authorizationConfig },
  });

  return {
    schema,
    executor(requestContext) {
      requestContext.context.authenticationConfig = authenticationConfig;
      requestContext.context.authorizationConfig = authorizationConfig;

      return execute({
        document: requestContext.document,
        schema: schema,
        contextValue: requestContext.context,
        operationName: requestContext.operationName ?? requestContext.request.operationName,
        variableValues: requestContext.request.variables,
      });
    },
  };
}

function getPolicyQueryName({ namespace, name }: ResourceMetadata) {
  return `${namespace}___${name}`.replace(/-/g, '_');
}

const defaultSchema: Schema = {
  metadata: { namespace: 'internal', name: 'default' },
  schema: 'type Query { default: String! @localResolver(value: "default") }',
};

const initialSchema: Schema = {
  metadata: {
    namespace: 'internal',
    name: '__initial__',
  },
  schema: `
    type Query {
        policy: Policy! @localResolver(value: {
            default: {
                allow: true
            }
        })
    }`,
};

declare module './context' {
  interface RequestContext {
    authenticationConfig: AuthenticationConfig;
    authorizationConfig: AuthorizationConfig;
  }
}
