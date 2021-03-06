import { SchemaDirectiveVisitor } from 'graphql-tools';
import { GraphQLField } from 'graphql';
import { gql } from 'apollo-server-core';
import { inject } from '../arguments-injection';
import { RequestContext } from '../context';

export class StubDirective extends SchemaDirectiveVisitor {
  visitFieldDefinition(field: GraphQLField<unknown, RequestContext>) {
    const { value } = this.args;

    field.resolve = (parent, args, context, info) =>
      typeof value === 'string' ? inject(value, parent, args, context, info) : value;
  }
}

export const sdl = gql`
  directive @stub(value: JSON!) on FIELD_DEFINITION
`;
