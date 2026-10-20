const assert = require("node:assert/strict");
const test = require("node:test");
const { timed } = require("../scripts/timed");
const { sum } = require("../src/sum");

test("sum adds two numbers", () =>
  timed("test", () => {
    assert.equal(sum(2, 3), 5);
  }));
