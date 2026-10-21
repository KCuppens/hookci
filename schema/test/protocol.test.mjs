import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const schemaURL = new URL("../hookci.schema.json", import.meta.url);
const fixturesURL = new URL("../testdata/protocol/", import.meta.url);

const schema = JSON.parse(readFileSync(schemaURL, "utf8"));
const ajv = new Ajv2020({ allErrors: true });
ajv.addSchema(schema);

const defs = schema.$defs.protocol.$defs;
const ref = (name) => `${schema.$id}#/$defs/protocol/$defs/${name}`;
const frame = ajv.getSchema(ref("Frame"));

// Message def for each frame type, read from the type const of every def.
const defByType = new Map(
  Object.entries(defs)
    .filter(([, def]) => def.properties?.type?.const)
    .map(([name, def]) => [def.properties.type.const, name]),
);

const fixtures = readdirSync(fixturesURL).filter((f) => f.endsWith(".json"));

test("fixtures exist for both outcomes", () => {
  assert.ok(fixtures.some((f) => f.startsWith("valid-")));
  assert.ok(fixtures.some((f) => f.startsWith("invalid-")));
  for (const f of fixtures) {
    assert.match(f, /^(valid|invalid)-/, `${f} must start with valid- or invalid-`);
  }
});

for (const file of fixtures) {
  const wantValid = file.startsWith("valid-");
  test(`${file} ${wantValid ? "passes" : "fails"}`, () => {
    const data = JSON.parse(readFileSync(new URL(file, fixturesURL), "utf8"));
    const name = defByType.get(data.type);
    assert.ok(name, `${file}: type ${JSON.stringify(data.type)} is not a protocol message`);
    const message = ajv.getSchema(ref(name));
    for (const [label, validate] of [[name, message], ["Frame", frame]]) {
      const ok = validate(data);
      assert.equal(ok, wantValid, `${file} against ${label}: ${ajv.errorsText(validate.errors)}`);
    }
  });
}
