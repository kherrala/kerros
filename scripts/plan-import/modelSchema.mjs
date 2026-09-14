// Derive the model-facing tool schema from the actual Mutation union, including every nested
// field in Floor, SiteObject, GeometryDrag, etc. No separately maintained list of model features.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function generateModelSchema() {
  const filename = resolve('src/model/mutations.ts');
  const program = ts.createProgram([filename], { strict: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(filename);
  const declaration = source.statements.find(s => ts.isTypeAliasDeclaration(s) && s.name.text === 'Mutation');
  const root = checker.getTypeAtLocation(declaration);
  const definitions = {};
  const seen = new Map();
  const schema = type => {
    if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return {};
    if (type.flags & ts.TypeFlags.StringLiteral) return { type: 'string', const: type.value };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { type: 'number', const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: type.intrinsicName === 'true' };
    if (type.flags & ts.TypeFlags.String) return { type: 'string' };
    if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
    if (type.isUnion()) {
      const members = type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
      if (members.length === 1) return schema(members[0]);
      const variants = members.map(schema);
      if (variants.every(v => v.type === variants[0].type && 'const' in v)) return { type: variants[0].type, enum: variants.map(v => v.const) };
      return { anyOf: variants };
    }
    if (checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type);
      // All current coordinate tuples are homogeneous. Fail on future heterogeneous tuples.
      const items = args.map(t => JSON.stringify(schema(t)));
      if (!items.every(v => v === items[0])) throw new Error('Model schema generator needs support for this tuple: ' + checker.typeToString(type));
      return { type: 'array', items: JSON.parse(items[0]), minItems: type.target.minLength, maxItems: args.length };
    }
    if (checker.isArrayType(type)) return { type: 'array', items: schema(checker.getTypeArguments(type)[0]) };
    if (type.flags & ts.TypeFlags.Object) {
      if (seen.has(type)) return { $ref: `#/$defs/${seen.get(type)}` };
      const name = `T${seen.size + 1}`;
      seen.set(type, name);
      const properties = {};
      const required = [];
      for (const property of checker.getPropertiesOfType(type)) {
        const definition = schema(checker.getTypeOfSymbolAtLocation(property, declaration));
        const description = ts.displayPartsToString(property.getDocumentationComment(checker));
        properties[property.name] = description ? { ...definition, description } : definition;
        if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
      }
      const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      definitions[name] = { type: 'object', properties, required, additionalProperties: index ? schema(index) : false };
      return { $ref: `#/$defs/${name}` };
    }
    throw new Error('Unsupported model type: ' + checker.typeToString(type));
  };
  const mutation = schema(root);
  return { mutation, definitions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = 'src/server/modelSchema.json';
  const output = JSON.stringify(generateModelSchema(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== output) throw new Error('AI model tools are stale. Run npm run generate:ai-tools.');
  } else writeFileSync(path, output);
}
