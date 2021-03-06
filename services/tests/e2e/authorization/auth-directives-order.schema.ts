import { gql } from 'apollo-server-core';
import { print } from 'graphql';
import { PolicyType, PolicyDefinition, Schema } from '../../../src/modules/resource-repository';

export const policies: PolicyDefinition[] = [
  {
    metadata: {
      name: 'alwaysDeny',
      namespace: 'auth_directives_order',
    },
    type: PolicyType.opa,
    code: `
      default allow = false
    `,
  },
];

export const schema: Schema = {
  metadata: {
    name: 'Schema',
    namespace: 'auth_directives_order',
  },
  schema: print(gql`
    type Query {
      ado_foo: String! @localResolver(value: "bar") @policy(namespace: "auth_directives_order", name: "alwaysDeny")
    }
  `),
};
